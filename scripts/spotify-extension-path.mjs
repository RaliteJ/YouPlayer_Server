import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Integration optionnelle ; aucun depot voisin n'est selectionne implicitement.
export const extensionDirectory = process.env.YOUPLAYER_EXTENSION_DIR
    ? resolve(process.env.YOUPLAYER_EXTENSION_DIR) : null;
export const extensionAvailable = Boolean(extensionDirectory
    && existsSync(resolve(extensionDirectory, "manifest.json")));

export function extensionFile(name) {
    if (!extensionAvailable) {
        throw new Error("Sources du pont facultatif absentes : definir YOUPLAYER_EXTENSION_DIR vers un dossier browser-extension compatible");
    }
    return pathToFileURL(resolve(extensionDirectory, name));
}
