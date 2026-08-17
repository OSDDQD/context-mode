import { describe, test, expect } from "vitest";
import { isReadOnlyCommand, findWriteCommands } from "../../src/read-only.js";

describe("isReadOnlyCommand (#1048)", () => {
  test("accepts plain inspection binaries", () => {
    for (const cmd of [
      "cat package.json",
      "ls -la src",
      "grep -rn TODO src",
      "find . -name '*.ts'",
      "wc -l src/server.ts",
      "jq '.scripts' package.json",
      "stat src/store.ts",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  test("accepts read subcommands of multiplexers", () => {
    for (const cmd of [
      "git log -20 --oneline",
      "git diff HEAD~1",
      "git status",
      "docker ps -a",
      "docker logs my-container",
      "kubectl get pods -n prod",
      "npm ls --depth=0",
      "systemctl is-active nginx",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  test("refuses write subcommands of the same multiplexers", () => {
    for (const cmd of [
      "git commit -m x",
      "git push origin main",
      "docker rm my-container",
      "kubectl delete pod foo",
      "npm install express",
      "systemctl restart nginx",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("refuses redirection, substitution and privilege escalation", () => {
    for (const cmd of [
      "cat file > out.txt",
      "cat file >> out.txt",
      "echo $(rm -rf /tmp/x)",
      "echo `whoami`",
      "sudo cat /etc/shadow",
      "cat /etc/passwd | tee copy.txt",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("allows pipes between read-only stages", () => {
    expect(isReadOnlyCommand("git log --oneline | head -20")).toBe(true);
    expect(isReadOnlyCommand("cat app.log | grep ERROR | wc -l")).toBe(true);
  });

  test("refuses a pipeline whose last stage writes", () => {
    expect(isReadOnlyCommand("cat app.log | xargs rm")).toBe(false);
  });

  test("sed is read-only unless it edits in place", () => {
    expect(isReadOnlyCommand("sed -n '1,20p' file.txt")).toBe(true);
    expect(isReadOnlyCommand("sed -i 's/a/b/' file.txt")).toBe(false);
    expect(isReadOnlyCommand("sed -i.bak 's/a/b/' file.txt")).toBe(false);
  });

  test("unknown binaries fail closed", () => {
    expect(isReadOnlyCommand("my-inhouse-cli status")).toBe(false);
    expect(isReadOnlyCommand("")).toBe(false);
  });

  test("leading env assignments do not confuse the classifier", () => {
    expect(isReadOnlyCommand("LANG=C grep -rn foo src")).toBe(true);
  });

  test("findWriteCommands names every offender, not just the first", () => {
    const offenders = findWriteCommands([
      { label: "ok", command: "git status" },
      { label: "bad1", command: "rm -rf build" },
      { label: "bad2", command: "npm install" },
    ]);
    expect(offenders.map(o => o.label)).toEqual(["bad1", "bad2"]);
  });
});
