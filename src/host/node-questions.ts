import { isAbsolute, relative, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { readQuestionSource, type NodeQuestion, type QuestionSource } from "../shared/node-questions.ts";
import { readQuestionIndex, writeQuestionIndex } from "./node-question-file.ts";
import { readNodeFast, withLibraryWrite } from "./v3/store.ts";

export async function questionFileSource(input: Record<string, unknown>, cwd: string): Promise<QuestionSource | undefined> {
  if (typeof input.absolutePath !== "string" || !isAbsolute(input.absolutePath)) return undefined;
  const [base, file] = await Promise.all([realpath(cwd), realpath(input.absolutePath)]);
  const path = relative(base, file);
  if (path === "" || path === ".." || path.startsWith(".." + sep) || isAbsolute(path) || !(await stat(file)).isFile()) {
    return undefined;
  }
  return readQuestionSource({ ...input, path: path.split(sep).join("/") });
}

export type QuestionChange =
  | { kind: "add"; item: NodeQuestion }
  | { kind: "process"; id: string; processed: boolean }
  | { kind: "delete"; id: string };

export async function listQuestions(root: string, nodeId: string): Promise<NodeQuestion[]> {
  if (!(await readNodeFast(root, nodeId)).ok) throw new Error("没有找到这个知识点");
  return (await readQuestionIndex(root))[nodeId] ?? [];
}

export async function changeQuestions(root: string, nodeId: string, change: QuestionChange): Promise<NodeQuestion[]> {
  return withLibraryWrite(root, async () => {
    if (!(await readNodeFast(root, nodeId)).ok) throw new Error("没有找到这个知识点");
    const nodes = await readQuestionIndex(root);
    const entries = nodes[nodeId] ?? [];
    let next: NodeQuestion[];
    if (change.kind === "add") {
      if (entries.some((item) => item.id === change.item.id)) return entries;
      next = [change.item, ...entries];
    } else {
      const index = entries.findIndex((item) => item.id === change.id);
      if (index < 0 || (change.kind === "process" && entries[index]!.processed === change.processed)) return entries;
      next = [...entries];
      if (change.kind === "delete") next.splice(index, 1);
      else next[index] = { ...entries[index]!, processed: change.processed };
    }
    if (next.length) nodes[nodeId] = next;
    else delete nodes[nodeId];
    await writeQuestionIndex(root, nodes);
    return next;
  });
}
