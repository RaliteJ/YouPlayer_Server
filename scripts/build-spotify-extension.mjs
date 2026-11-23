import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile, utimes, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFile } from "./spotify-extension-path.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromium = process.argv.includes("--chromium");
const artifactName = chromium ? "youplayer-spotify-bridge-chromium.zip" : "youplayer-spotify-bridge.xpi";
const artifact = join(root, "src/downloads", artifactName);
const { runtimeFiles: files } = await import(extensionFile("runtime-files.mjs"));
const manifest = JSON.parse(await readFile(extensionFile("manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(extensionFile("package.json"), "utf8"));
if (manifest.version !== metadata.version) throw new Error("Versions manifeste/package de l'extension incoherentes");
const contents = await Promise.all(files.map((name) => readFile(extensionFile(name))));
if (chromium) {
	delete manifest.browser_specific_settings;
	manifest.background = { service_worker: "background.js", type: "module" };
	manifest.minimum_chrome_version = "111";
	manifest.icons = { 48: "icons/youplayer-48.png", 128: "icons/youplayer-128.png" };
	manifest.action.default_icon = manifest.icons;
	contents[files.indexOf("manifest.json")] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
}

if (process.argv.includes("--check")) {
	const entries = execFileSync("unzip", ["-Z1", artifact], { encoding: "utf8" }).trim().split("\n").sort();
	if (JSON.stringify(entries) !== JSON.stringify([...files].sort())) throw new Error("Contenu du paquet different de la liste des sources");
	for (const [index, name] of files.entries()) {
		if (!execFileSync("unzip", ["-p", artifact, name]).equals(contents[index])) {
			throw new Error(`Paquet non synchronise : ${name}. Executer npm --prefix src run extension:build${chromium ? " -- --chromium" : ""}`);
		}
	}
	console.log(`Extension ${manifest.version} : paquet conforme aux sources locales`);
} else {
	const staging = await mkdtemp(join(root, ".extension-build-"));
	try {
		for (const [index, name] of files.entries()) {
			const destination = join(staging, name);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, contents[index], { mode: 0o644 });
			await utimes(destination, 946684800, 946684800);
		}
		const temporary = join(staging, "extension.xpi");
		execFileSync("zip", ["-q", "-X", temporary, ...files], {
			cwd: staging, env: { ...process.env, TZ: "UTC" }
		});
		await mkdir(dirname(artifact), { recursive: true });
		await rename(temporary, artifact);
		console.log(`Extension ${manifest.version} construite dans src/downloads/${artifactName}`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
