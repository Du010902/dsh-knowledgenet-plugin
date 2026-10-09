import { readNodeFast, withLibraryWrite } from "./v3/store.ts";
import { readUnderstanding, writeUnderstandingFile } from "./understanding-file.ts";
export { readUnderstanding } from "./understanding-file.ts";

/** Serialize each library's marks without changing note contents or conflict fingerprints. */
export async function setUnderstanding(root: string, id: string, understood: boolean): Promise<Record<string, boolean>> {
  return withLibraryWrite(root, async () => {
    const node = await readNodeFast(root, id);
    if (!node.ok) throw new Error("没有找到这个知识点");
    const nodes = await readUnderstanding(root);
    nodes[id] = understood;
    await writeUnderstandingFile(root, nodes);
    return nodes;
  });
}
