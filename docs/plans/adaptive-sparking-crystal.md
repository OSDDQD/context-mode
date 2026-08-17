# План работ по context-mode: P0 / P1 / P2

## Context

Плагин экономит контекст, но при разборе его работы обнаружились дефекты,
которые режут именно то, ради чего он существует: часть каждого ответа поиска —
дословные повторы; база знаний может быть стёрта через час после нештатного
завершения сессии в обход 14-дневного правила; индекс одного проекта загрязняется
файлами другого; метрики в `ctx_stats` противоречат сами себе.

Цель трёх фаз: **P0** — убрать доказанные потери и вернуть честность отчётов;
**P1** — дать модели понимание полноты выдачи, снять риски исполнения и
устранить лишнюю переиндексацию; **P2** — измеримое качество поиска, чанкинг
кода и приватность.

Правки — **только в форке OSDDQD**. Конвенции формы: каждый новый дефолт
получает `CONTEXT_MODE_*`-переключатель обратно; изменения — в
`docs/FORK-CHANGES.md`; решения о семантике — ADR в `docs/adr/`; измеряемые
утверждения — `docs/research/*.md` + харнесс в `scripts/`.

### Измерено в ходе разведки (факты, не оценки)

| Что | Замер |
|---|---|
| Дубли в выдаче | 3 реальных `batch:`-источника, 45 показов / 30 уникальных чанков → **37.0% выведенных байт — повторы** (46.1 / 34.0 / 30.9% по батчам; один чанк отрендерен 4 раза) |
| Семантика | Ollama :11434 отвечает, `bge-m3` установлена, эндпоинт `200`; в БД 480 векторов на 1854 чанка. `ctx_stats` показал «0 of 1,320 (0%)» и советует ждать фонового прогрева, которого при 16 чанках на поиск не хватает |
| Диск | `~/.claude/context-mode` = 208 МБ: `content/` — 328 БД (180.4 МБ) + 328 WAL (30.1 МБ); 297 БД < 100 КБ; максимум 54 МБ |
| Мусор от тестов | 297 мелких БД содержат источники `/tmp/ctx-index-*`, `test-inline` — артефакты `npm test`: фейковый HOME (`tests/setup-home.ts`) подключается **opt-in по сьютам** |
| `sessions/` | 755 файлов, из них **735 — `stats-pid-*.json`** (`src/server.ts:1275`), которые никто не удаляет, а `ctx_stats` читает все |
| Кросс-проектная утечка | Очередь код-индекса — **один файл** `code-index-queue.txt` на весь `sessionsDir` (`src/session/code-index.ts:28,123`); в БД `context-mode` лежат 48 `code:`-источников чужих проектов из 253. Та же схема у `subagent-capture-queue.jsonl` |
| Часовой реапер БД | `cleanupStaleContentDBs` (`src/store.ts:222`) удаляет `.db`/`-wal`/`-shm`, если WAL непустой и старше **1 часа** — PID не проверяется вопреки комментарию, 14-дневное правило обходится (код прочитан, ветка подтверждена). Срабатывает после нештатного завершения, когда `close()` не успел сделать checkpoint; на момент проверки под условие не попадала ни одна БД, но у активной БД этого проекта WAL был 15.8 МБ |
| Scratchpad как проект | Из 102 `project_dir` в сессионных БД **41 — `/tmp/claude-*/…/scratchpad`**; content-БД они не плодят, но завышают «101 projects» в `ctx_stats` |
| Чанкинг кода | На выборке из 400 чанков реальных исходников (`.ts/.py/.php/.js`) только **30.5% начинаются с границы объявления** — остальные обрываются посреди конструкции (`for spec in cycle.legs:`, `@property`, тело assert) |
| Скрининга содержимого нет | В индексе этого проекта встречаются маркеры `sk-` (21 чанк), `Bearer ` (14), `api_key=` (3), `ghp_` (1). Это подстроки, а не подтверждённые ключи, но фильтр сегодня смотрит только на **имя файла**, не на содержимое |

---

# P0 — доказанные потери и честность (11 коммитов)

## P0.0 Часовой реапер (делать первым)

`src/store.ts:222`, ветка «зомби-WAL». Условие `walStat.size > 0 && age > 1h`
ставит тот же `shouldClean`, что и возраст, — и удаляет БД. Правка: ветка WAL
может действовать **только внутри** возрастного правила
(`shouldClean = mtime < cutoff && walIsStale`), плюс `CONTEXT_MODE_CONTENT_RETENTION_DAYS`
(дефолт 14) и `CONTEXT_MODE_CONTENT_WAL_REAP=0`. Поведение сейчас ничем не
покрыто тестами — добавить три случая в `tests/store.test.ts`.

Почему первым: любые измерения бюджета диска поверх пола, который сам всё
стирает, бессмысленны.

## P0.1 Дедупликация выдачи между запросами

**Ключ.** `fusionKey` (`src/search/hybrid.ts:59`) переименовать в
экспортируемый `chunkIdentity` — `source + title + content.slice(0,120)`.
Ключ `source::title` из `#rrfSearch` не годится: в живом индексе есть
`Untitled (12)`, `… (1)`, `… (2)`.

**Правило подавления (свойство безопасности).** Подавляется **только
байт-идентичный текст, уже выведенный выше в этом же ответе**:
- новый чанк → рендерится целиком;
- тот же чанк, тот же сниппет → заголовок + строка
  `(identical to the section shown under "<первый запрос>" — not repeated)`;
- тот же чанк, **другое окно** сниппета (`extractSnippet` даёт окна ±300
  символов) → рендерится целиком с пометкой `— further match`.

Информация не теряется никогда, только дословный повтор. Запрос, все результаты
которого — дубли, показывает заголовки и ссылки, а **не** `No matching sections found.`

**Файлы.** `src/server.ts`: новый класс `CrossQueryDeduper` + `searchDedupEnabled()`
сразу после `extractSnippet` (после 1627); в `formatBatchQueryResults` (1631)
экземпляр создаётся **вне** цикла по запросам, ветвление в цикле результатов
(1673-1679), футер `> Deduplicated N repeated section(s) (~X KB not repeated).`
перед блоком tip (1687); в обработчике `ctx_search` — то же в `.map()` (3060-3069),
футер перед строкой throttle. Одна правка `formatBatchQueryResults` покрывает и
`ctx_gather` (общий `runBatchExecute`).

**Env:** `CONTEXT_MODE_SEARCH_DEDUP` (вкл; `0` → байт-в-байт прежний вывод).

**Тесты:** новый `tests/core/search-dedup.test.ts` (7 случаев, включая
«единственный ответ не спрятан» и байт-идентичность при `=0`); проверить
`tests/core/batch-hybrid-scope.test.ts` (пинит строки tip и наличие заголовка).

**Измерение:** `scripts/measure-search-dedup.mjs` + `docs/research/search-dedup-<дата>.md`.

## P0.2 Видимость семантического слоя

**a.** `semanticIndexReport()` (`src/server.ts:977-1005`) при `vectors === 0`
сейчас утверждает, что «backfill идёт на каждом поиске» — это ложь, когда
эмбеддера нет. Три ветки вместо одной строки: `0 векторов` → «hybrid неактивен,
как включить + `context-mode drain`»; `0 < pct < 100` → «прогрев после поиска и
на завершении сессии»; `100%` → ничего.

**b.** `backfillVectorsUntil(db, {deadlineMs, maxChunks})` — новый экспорт в
`src/search/hybrid.ts` рядом с `backfillVectors` (после 197); вызов в
`drainCommand` (`src/cli.ts:527-549`), который `hooks/sessionend.mjs` уже
запускает отцеплённо. Сегодня для 1320 чанков нужно ~83 поиска.

**c.** `semanticStatusHint()` — одна строка, **один раз на процесс**, только при
покрытии < 100% и индексе ≥ 200 чанков; в `ctx_search` и в
`formatBatchQueryResults` только при `scope: "global"`.

**Env:** `CONTEXT_MODE_SEMANTIC_HINT`, `CONTEXT_MODE_DRAIN_BACKFILL`,
`CONTEXT_MODE_DRAIN_BACKFILL_MS` (60000), `CONTEXT_MODE_DRAIN_BACKFILL_MAX` (2000).

**Тесты:** `tests/core/semantic-visibility.test.ts`; расширить
`tests/core/hybrid-search.test.ts` (стоп по `maxChunks`, стоп по дедлайну,
0 при выключенных эмбеддингах).

## P0.3 Диск: учёт, бюджет, компакция

- **a. Учёт.** `contentStoreUsage(contentDir)` в `src/store.ts` рядом с
  `cleanupStaleContentDBs`: чистый `statSync`-обход, считает `.db` + `-wal` + `-shm`
  (WAL — 14% футпринта), даёт `lastUseMs`. Это же используется в P0.4.
- **b. Бюджет.** `enforceContentBudget({contentDir, protectPaths, budgetBytes,
  minAgeMs, dryRun})`: быстрый выход, если под бюджетом; защита — свой открытый
  `dbPath`, живой непустой WAL, возраст < `minAgeMs` (48 ч); вытеснение по
  `lastUseMs` до `budget*0.9`. Вызов **только в `drainCommand`**, не в `getStore()`.
  Дефолт `CONTEXT_MODE_CONTENT_BUDGET_MB=512` выше измеренных 208 МБ →
  первая версия ничего не удаляет, только печатает футпринт.
- **c. Компакция.** `ContentStore.compact()` рядом с `getDBSizeBytes()` (1636):
  `VACUUM` только при `freelist_count × page_size > max(1 МБ, 0.2×size)` и размере
  ниже `CONTEXT_MODE_VACUUM_MAX_BYTES` (256 МБ); вызывается из `drain`, **никогда**
  из `close()`.

**Тесты:** `tests/core/content-budget.test.ts` (10 случаев: защита открытой БД,
живой WAL, порог возраста, dry-run, sidecar-файлы); в `tests/store.test.ts` —
`compact()` и три случая ретенции из P0.0.

## P0.4 Кросс-проектная утечка индекса

Очередь одна на все проекты, а дренаж пишет всё в БД того проекта, чей сервер
открылся первым.

- `drainCodeIndexQueue` (`src/session/code-index.ts:142-190`): пути **вне**
  `projectDir` не индексировать, а возвращать в очередь (как уже делает
  `overflow`), чтобы их забрал правильный сервер.
- Имя очереди — по хешу проекта (`code-index-queue-<hash>.txt`), как у
  content-БД; старый общий файл дочитывается один раз и удаляется.
- То же для `subagent-capture-queue.jsonl` (`src/session/subagent-capture.ts:27,65`).
- Одноразовая чистка: удалить из БД `code:`-источники с абсолютным путём вне
  своего `projectDir` (уже есть `deleteSource`, ср. `pruneDeletedCodeSources`).

**Env:** `CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE=0` — вернуть общее поведение.
**Тесты:** расширить `tests/core/code-index.test.ts` — чужой путь не индексируется
и остаётся в очереди; метка своего файла по-прежнему относительная.

## P0.5 Честные метрики

ADR-0004 фиксирует **только** формулу Секции 1 — её не трогаем и закрепляем
регрессионным тестом. Всё ниже — Секции 3–4.

Причина «This chat 6.9 MB > All your work 6.7 MB»: (1) `getConversationWindowStats`
(`analytics.ts:1456`) берёт пул по **всему worktree за всё время** — так задумано,
чтобы засчитать субагентов, которые делят cwd-хеш (см. комментарий на 1437-1454),
но побочно туда попадают и прошлые чаты, а подпись говорит «This chat»;
(2) `scanOneAdapter` держит `contentBytes: 0` (`analytics.ts:1541`), то есть
широкая область не считает то, что считает узкая. Правим подпись и вложенность,
а не замысел.

- Три подписанных уровня: `This session` / `This project` / `All your work`
  (сессия добавляется как новая строка, существующие числа не уменьшаются).
- Инвариант вложенности через подъём широкой области:
  `lifetimeShown = max(projectShown, rawLifetime)` — совместимо с правилом
  «числа только растут» (`analytics.ts:2903`).
- Отдельная строка «Knowledge base on disk: N МБ across M store(s)» из
  `contentStoreUsage` — это футпринт, **не** «kept out».
- Долларовый блок: измеренный заголовок остаётся, экстраполяция на 10 разработчиков
  уходит под `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION=1`, вся секция — под
  `CONTEXT_MODE_STATS_COST=0`; добавляется строка `Basis:` о том, что база —
  собственный учёт плагина, а не A/B-замер.
- `AnalyticsEngine.contextSavingsTotal` (311) пометить `@deprecated` — это мёртвый стаб.
- **ADR-0005 «Stats scope labels and containment»**, `Extends: ADR-0004`.

**Сломаются (ожидаемо):** `tests/session/format-cost.test.ts:60-69`,
`stats-output-format.test.ts`, `multi-adapter-render.test.ts`,
`format-report-real-bytes.test.ts`, `scripts/prove-narrative-render.ts`.

## P0.6 Гигиена хранилища (дешёвое дополнение)

- `stats-*.json`: удалять файлы старше N дней при агрегации в
  `patchPiLifetimeFromStatsFiles` (`src/server.ts:4853`) — сейчас их 735.
- `vitest.config.ts`: подключить изоляцию HOME глобально через `setupFiles`,
  чтобы `npm test` перестал писать в реальный `~/.claude/context-mode`
  (сегодня — opt-in по сьютам, отсюда 297 мусорных БД).

## Порядок P0

`P0.0` → `P0.1` (+измерение) → `P0.2a` → `P0.4` → `P0.2b/c` → `P0.3a` → `P0.3b`
→ `P0.3c` → `P0.5` (+ADR-0005) → `P0.6` → `docs/FORK-CHANGES.md`.

---

# P1 — архитектурные улучшения (5 шагов)

Порядок: **P1.1 (executor) → P1.2 (hash-skip) → P1.3 (полнота) → P1.4 (формулировки)
→ P1.5 (распил `server.ts`) последним**, потому что все остальные пункты правят
`server.ts`, и распил по движущейся цели пришлось бы переделывать трижды.

## P1.1 Мягкое усиление исполнения

Урок #406 — про **wall-clock**. 30-минутная сборка печатает непрерывно; зависший
процесс молчит. Поэтому дефолт — **сторож простоя**, а не таймер.

- В `#spawn` (`src/executor.ts:417-580`) добавить `idleTimer`, взводимый только
  при `timeout === undefined`, не в `background`; сброс — одной строкой в двух
  уже существующих обработчиках данных (520, 532). Явный `timeout` не трогаем
  вовсе. `resolveExecTimeout` (`src/server.ts:1762`, только для `agy`) — другой слой,
  не трогаем.
- `ExecResult` получает `killedBy?: "timeout" | "idle" | "wall" | "output-cap"`;
  `timedOut` остаётся `true`, чтобы потребители не сломались.
- Порог вывода: `CONTEXT_MODE_EXEC_MAX_OUTPUT_BYTES` (32 МБ вместо 100 МБ).
- SIGTERM с отсрочкой `CONTEXT_MODE_EXEC_KILL_GRACE_MS` (2000) перед SIGKILL в
  `killTree`; на пути «превышен вывод» — 0, там нужно рубить сразу.
- `CONTEXT_MODE_EXEC_ENV_MODE=allowlist` (по умолчанию `denylist` = текущее
  поведение) — самый ценный из мягких шагов: сегодня `AWS_*` и любые токены
  уходят в дочерний процесс.
- `PYTHONUNBUFFERED=1` в форсируемых переменных — иначе Python буферизует вывод
  и станет главным ложным срабатыванием сторожа.
- `ulimit`-пролог (fsize / nproc / as) — **все три по умолчанию выключены**:
  `-u` на Linux считается на пользователя и задушит сам хост, `-v` ломает JVM/Go/Node.

**Рекомендация:** первую ревизию выпустить с `CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS=0`
(выключено), включить `600000` следующей ревизией по факту эксплуатации.

**Тесты:** `tests/executor/idle-timeout.test.ts` — «болтливая» команда переживает
сторож (анти-#406), молчаливая убивается, явный `timeout` работает как прежде,
`background` не трогается, `=0` возвращает безлимит. Фикстуры на `node -e`, а не
`sleep`, ради Windows-CI.

## P1.2 Кэш по хешу содержимого

В `ContentStore.index()` (`src/store.ts:850-904`) сегодня перезапись безусловна,
а `content_hash` уже пишется, но не сравнивается. Пропускать индексацию, если:
запись существует, хеши совпадают (оба непустые) и `file_path` не изменился.
Хеш считать для **всех** источников, не только файловых — тогда выигрыш получают и
повторяющиеся команды батча.

Две неочевидные детали:
- при пропуске **обновлять `indexed_at`**, иначе `#refreshStaleSources` (1427)
  будет перечитывать файл на каждом поиске;
- пропуск сохраняет `chunks.rowid`, а значит **сохраняет векторы**
  (`chunk_vectors` привязаны к rowid): сегодня каждая переиндексация неизменного
  файла осиротняет эмбеддинги и заставляет считать их заново.

Схема БД не меняется — `sources.content_hash` уже есть, дорогой пересоздающей
миграции (`store.ts:517-549`) не требуется.

**Компромисс, который надо принять явно:** при пропуске чанки сохраняют
`session_id` первой сессии. `UPDATE` не спасает — это FTS5-колонка, обновление
меняет rowid и убивает выигрыш. Решение: «первый писатель побеждает», записать в
**ADR-0007 «Content-hash index cache»**, дать
`CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE=1`.

Нумерация ADR по плану: **0005** — области и вложенность метрик (P0.5),
**0006** — позиция по изоляции исполнения (P1.4), **0007** — кэш по хешу (P1.2).

**Тесты:** новый `tests/store-hash-skip.test.ts` (rowid стабильны, легаси-NULL
переиндексируется один раз, `=0` возвращает перезапись) + тест сохранности
векторов: `pruneOrphanVectors` после повторной индексации возвращает 0.

## P1.3 Сигнал полноты и путь эскалации

`#rrfSearch` (`src/store.ts:1256`) уже знает `scoreMap.size` до `.slice(limit)`, а
насыщенность пула определяется тем, вернул ли какой-то из слоёв ровно `fetchLimit`
строк. Отсюда правило: **«complete» заявляется только когда пул доказуемо не
насыщен**, иначе `N+`. Ошибка всегда в безопасную сторону.

- `searchWithFallbackMeta(...)` рядом с `searchWithFallback` (1352), старая
  сигнатура остаётся делегатом — ни один вызов и тест не ломается.
- Новый модуль `src/search/completeness.ts` (формат строк, без импорта `server.ts`).
- Строка на запрос: `> Showing 3 of 11 matching section(s). More: ctx_search(...)`
  либо `> Complete: all 4 matching section(s) shown.`
- Блок эскалации — один на ответ, перед строкой throttle.
- В режиме `sort: "timeline"` строка **не выводится**: там сливаются три
  разнородных источника, честнее промолчать.
- Добавки из hybrid/auto-memory не попадают в знаменатель, а идут отдельным
  «(+2 from memory/semantic)».

**Env:** `CONTEXT_MODE_SEARCH_COMPLETENESS`, `CONTEXT_MODE_SEARCH_EXACT_TOTALS`
(включает точный `COUNT(*)`), `CONTEXT_MODE_SEARCH_ESCALATION`.

## P1.4 Честные формулировки исполнения

Сейчас описания обещают «sandboxed subprocess», хотя `cwd` — реальный корень
проекта, env — денилист, изоляции нет. Заменить на «separate subprocess» в
описаниях инструментов, `hooks/routing-block.mjs`, README и skills; фраза, которая
реально управляет маршрутизацией («only what you print enters the conversation»),
остаётся дословно. Внутренние идентификаторы (`bytesSandboxed`, `bytes_sandboxed`
в статистике) **не переименовывать**.

ADR-0002 требует, чтобы правки описаний были подтверждены пробами — значит нужен
`scripts/measure-sandbox-wording.mjs` + запись в `docs/research/`, и
**ADR-0006 «Execution isolation posture»** с объяснением, почему bwrap/landlock
отвергнуты (матрица CI из трёх ОС, разрешения хоста уже гейтят инструмент) и
почему сторож — по простою.

**Сломаются:** `tests/core/compact-descriptions.test.ts:25,82` (ожидают строку
`sandbox`) — правятся в том же коммите.

## P1.5 Распил `src/server.ts`

Границу выбирать не по строкам, а по тому, что форк **уже** переписал:

```
git diff -U0 $(git merge-base HEAD upstream/next) HEAD -- src/server.ts | grep '^@@'
```

Переносить только регионы с форк-хуками: они и так конфликтуют при каждом
`sync-upstream`, значит перенос не добавляет издержек. Регионы, которых форк не
касался, оставить на месте — их перенос гарантирует delete/modify-конфликт при
каждом мерже ради нулевой выгоды.

**Волна 1:** `src/tools/shared/state.ts` (`_store`, `getStore`, `sessionStats`,
`trackResponse`/`trackIndexed`, `_detectedAdapter`), `src/tools/shared/deps.ts`
(тип `ToolDeps` — он же защита от циклов), `src/tools/search.ts`,
`src/tools/batch.ts`. **Волна 2** (отдельно): `tools/fetch.ts` (~1400 строк),
`tools/ops.ts`.

**Никогда не переносить:** создание MCP-сервера, `__pkg_dir` и производные
(в неупакованной сборке путь резолвится иначе), `tools/list`-override, `main()`,
любые побочные эффекты уровня модуля.

**Первый коммит — no-op:** `tests/shared/server-source.ts` с хелпером
`serverSource()`, потому что **30 загрузчиков в 22 файлах читают `src/server.ts`
как текст**. Сначала перевести все на хелпер при неизменном поведении, потом
расширять glob.

Приёмка: `npx madge --circular --extensions ts src/`, новый
`tests/core/tool-registration.test.ts` (все 12 инструментов в прежнем порядке),
размер `server.bundle.mjs` до/после.

---

# P2 — качество, чанкинг, приватность

## P2.1 Харнесс качества поиска (расширение, не с нуля)

Зачаток уже есть: `tests/core/search.test.ts:2747-2804`,
`describe("Search relevance eval — competitive corpus")` — 12 документов
(`RELEVANCE_CORPUS`, строка 2696), хелперы `topOne` (precision@1) и `ranking`
(recall@5 + негативные исключения + проверка `matchLayer`), 16 кейсов. Чего нет:
корпус вшит в 3364-строчный тест-файл, агрегированной метрики нет, базовой линии
для сравнения нет, семантический путь не покрыт (`tests/core/hybrid-search.test.ts`
проверяет только механику: парсинг конфига, кодек векторов, косинус тривиальных
векторов).

- Вынести корпус в `tests/fixtures/relevance-corpus.json` (документы + запросы +
  ожидания), тест-файл импортирует его — те же 16 кейсов продолжают работать.
- Расширить до ~40 документов и ~60 запросов, добавив то, чего в корпусе нет:
  русские запросы к английским чанкам, длинные файлы кода (проверка окон),
  запросы-парафразы (то, где лексика обязана проигрывать, а семантика выигрывать).
- Новый `scripts/measure-retrieval.mjs`: печатает **агрегат** — precision@1,
  recall@5, MRR — отдельно для лексики и для гибрида, и пишет
  `docs/research/retrieval-<дата>.md`. Базовая линия хранится в
  `tests/fixtures/retrieval-baseline.json`.
- Гейт в `npm test` — **только лексический** и только как «не хуже базовой линии
  минус допуск»; семантическая часть запускается отдельным скриптом и в CI не
  участвует. Причина: флаки-гейт хуже отсутствующего, а семантика требует живого
  эндпоинта (в тестах уже есть образец пропуска при выключенных эмбеддингах).

## P2.2 Чанкинг, учитывающий структуру кода

Замер: из 400 чанков реальных исходников только **30.5%** начинаются с границы
объявления. Остальные рвут функцию посередине, что бьёт и по BM25 (заголовок
чанка — первая строка, `CHUNK_TITLE_MAX_CHARS`), и по эмбеддингам.

- **Без новых зависимостей.** Список `dependencies` намеренно короткий (8 пакетов),
  а `tree-sitter`/`@babel/parser` тянут нативные бинарники или мегабайты в бандл.
  Вместо парсера — эвристический `#chunkCode`: границы по строкам, начинающимся в
  нулевом отступе с `export|function|class|def|impl|interface|type|public|private|
  async|package|@|/**`, с прилипанием предшествующего docstring/комментария к
  следующему блоку; всё, что не распознано, падает в текущий `#chunkPlainText`.
- Включается только для `content_type === "code"` и известных расширений
  (`INDEXABLE_EXTENSIONS`, `src/session/code-index.ts:38`).
- **Все инварианты байтового кэпа сохраняются** — `#splitOversizedPlainChunk`
  остаётся последним этапом, поэтому кейсы `tests/store-bytecap.test.ts` (#781:
  CJK по байтам, эмодзи без разрыва суррогатной пары, полоса 4097–4999 Б)
  продолжают выполняться.
- Схема БД не меняется; переиндексация не нужна — новые чанки появятся
  естественно при следующем изменении файла (а с P1.2 неизменные файлы вообще
  не трогаются).
- Метрика приёмки: доля чанков, начинающихся с границы объявления, на том же
  замере — цель ≥ 80% против нынешних 30.5%; плюс отсутствие регрессии в
  харнессе P2.1.

**Env:** `CONTEXT_MODE_CODE_CHUNKING=0` — вернуть плоский чанкинг.

## P2.3 Приватность: отчёт и скрининг содержимого

Сегодня фильтр (`isSensitivePath`, `src/session/code-index.ts:96`) смотрит только
на **имя файла**, и только для файлов, попавших в код-индекс. Вывод команд,
загруженные страницы, дайджесты субагентов и память хоста не проверяются вовсе.
В индексе этого проекта встречаются маркеры `sk-` (21 чанк), `Bearer ` (14),
`api_key=` (3), `ghp_` (1) — это подстроки, а не подтверждённые ключи, но
показывают, что скрининга содержимого нет.

- **`context-mode inventory [--project path] [--json]`** — новая CLI-команда рядом
  с `drain`/`index` (`src/cli.ts:239`), использует уже существующие `listSources()`
  (`store.ts:1481`) и `getIndexState()` (1494). Печатает: сколько источников и
  чанков по типам (сейчас в этом проекте — `code` 253/1404, `batch` 41/433),
  топ по объёму, дату последней индексации, размер БД. Это ответ на вопрос
  «что вообще про меня записано», которого сегодня нет.
- **Скрининг при записи** — в `ContentStore.index()` перед чанкингом, только
  строчный: известные префиксы токенов (`sk-`, `ghp_`, `gho_`, `AKIA`,
  `-----BEGIN * PRIVATE KEY-----`, `xox[baprs]-`) и пары `ключ=значение`, где ключ
  совпадает с `SENSITIVE_NAME_HINT`, а значение длиннее 16 символов. Замена на
  `«[redacted:<тип>]»`, счётчик редакций в результате индексации.
- **Энтропийный детектор — не включать по умолчанию.** На реальном коде он даёт
  ложные срабатывания на base64-ассетах, минифицированных файлах, UUID и git-хешах,
  а обещание «секреты не попадут» он всё равно не выполнит. Оставить
  `CONTEXT_MODE_INDEX_ENTROPY_REDACT=1` как opt-in и честно написать в документации,
  что это эвристика, а не гарантия.
- В `ctx_purge` (`src/server.ts:5391`) добавить точечный вариант: удалить один
  источник по метке (`deleteSource` уже есть) — сейчас доступно только «стереть всё».

**Env:** `CONTEXT_MODE_INDEX_REDACT` (вкл), `CONTEXT_MODE_INDEX_ENTROPY_REDACT` (выкл).

## Что резать, если ресурс только на одно

**P2.1** — единственный пункт, который окупается независимо от остальных: без
измеримой базовой линии любые правки ранжирования (RRF, веса BM25, чанкинг,
гибрид) принимаются вслепую, и P2.2 нечем будет подтвердить. **P2.2** — вторым:
эффект понятен и измерим, но он же самый рискованный по регрессиям. **P2.3** —
последним: отчёт `inventory` дёшев и полезен сразу, а вот редактор секретов легко
превращается в источник ложного чувства безопасности, поэтому его ценность
ниже, чем кажется.

---

## Верификация (общая)

```bash
cd /home/osddqd/projects/context-mode
rm -f server.bundle.mjs        # CONTRIBUTING.md: иначе start.mjs не увидит правки
npm run build && npx tsc --noEmit && npm test && npm run assert-bundle
```

Пофазно:

```bash
# P0.1
npx vitest run tests/core/search-dedup.test.ts tests/core/batch-hybrid-scope.test.ts
node scripts/measure-search-dedup.mjs        # ждём savedPct ≈ 30–45%
CONTEXT_MODE_SEARCH_DEDUP=0 npx vitest run tests/core/search-dedup.test.ts

# P0.0 — доказательство реапера (до и после правки)
node -e 'const {cleanupStaleContentDBs}=require("./build/store.js");const fs=require("fs"),os=require("os"),p=require("path");
const d=fs.mkdtempSync(p.join(os.tmpdir(),"cm-ret-"));fs.writeFileSync(p.join(d,"fresh.db"),"x");
fs.writeFileSync(p.join(d,"fresh.db-wal"),"y");const old=(Date.now()-2*3600e3)/1000;
fs.utimesSync(p.join(d,"fresh.db-wal"),old,old);
console.log("removed:",cleanupStaleContentDBs(d,14),"survived:",fs.existsSync(p.join(d,"fresh.db")));'
# до: removed: 1 survived: false   после: removed: 0 survived: true

# P0.2
node build/cli.js drain --project $PWD     # ждём "K vector(s)" > 0, затем рост покрытия в ctx_stats

# P0.3 (сухой прогон на реальных данных)
CONTEXT_MODE_CONTENT_BUDGET_DRY_RUN=1 CONTEXT_MODE_CONTENT_BUDGET_MB=150 \
  node build/cli.js drain --project $PWD --dry-run   # свой .db обязан отсутствовать в списке

# P0.4
sqlite3 ~/.claude/context-mode/content/<hash>.db \
  "SELECT COUNT(*) FROM sources WHERE label LIKE 'code:/%';"   # ждём 0 после чистки

# P1.1 / P1.2 / P1.3
npx vitest run tests/executor/ tests/store-hash-skip.test.ts tests/search/
node scripts/measure-index-skip.mjs        # база для сравнения — 12.5 мс/файл
```

## Ключевые файлы

- `src/server.ts` — `extractSnippet` (1560), `formatBatchQueryResults` (1631),
  `semanticIndexReport` (977), `getStore` (850), `ctx_search` (2829-3095),
  `ctx_stats` (4890-5078), `patchPiLifetimeFromStatsFiles` (4853)
- `src/store.ts` — `cleanupStaleContentDBs` (222, баг реапера), `index()` (850),
  `#rrfSearch` (1256), `searchWithFallback` (1352), `#refreshStaleSources` (1427),
  `getDBSizeBytes`/`close` (1636-1657)
- `src/search/hybrid.ts` — `fusionKey` (59), `vectorCoverage` (141),
  `backfillVectors` (167), единственный вызывающий (385)
- `src/session/code-index.ts` — очередь (28, 123), `drainCodeIndexQueue` (142),
  `codeSourceLabel`, `isSensitivePath` (96)
- `src/session/analytics.ts` — `getConversationWindowStats` (1456),
  `scanOneAdapter` `contentBytes: 0` (1541), рендер Секции 3 (2295-2320),
  `renderCostExample` (2012)
- `src/executor.ts` — `#spawn` (417), `#buildSafeEnv` (582), `killTree` (197)
- `src/cli.ts` — `drainCommand` (527), `openCliContentStore` (509)
