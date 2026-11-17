#!/usr/bin/env node
// Idempotent local installer for dsh-effort-lab.
//
//   node scripts/install.mjs --profile <name> [--dry-run]
//   node scripts/install.mjs --profile <name> --uninstall [--dry-run]
//
// `dsh plugin add` records the dependency in the profile package.json and appends
// the bundle to dsh.profile.bundles; the profile's own cordis.patch.yml is not
// touched. Re-running is safe. DSH is never restarted.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import url from "node:url";

const PACKAGE_NAME = "@flyer103/dsh-effort-lab";
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME?.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(os.homedir(), ".dsh");

function fail(message) {
  console.error(`dsh-effort-lab: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { profile: undefined, uninstall: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      options.profile = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      options.profile = argument.slice("--profile=".length);
    } else if (argument === "--uninstall") {
      options.uninstall = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      fail(`unknown argument ${JSON.stringify(argument)} (try --help)`);
    }
  }
  if (options.help) return options;
  if (options.profile === undefined || options.profile === "") {
    fail("--profile <name> is required (for example: --profile desktop)");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.profile)) {
    fail(`invalid profile name ${JSON.stringify(options.profile)}`);
  }
  return options;
}

function state(profileDir) {
  const manifestPath = path.join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    return { manifestPath, manifest: undefined, dependency: undefined, bundleListed: false };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    manifestPath,
    manifest,
    dependency: manifest.dependencies?.[PACKAGE_NAME],
    bundleListed: manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true,
  };
}

function run(args) {
  const result = spawnSync("dsh", ["plugin", "--profile", options.profile, ...args], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    fail("the `dsh` command is not on PATH; install DeepSeek Harness or add its CLI to PATH");
  }
  if (result.status !== 0) fail(`dsh plugin ${args.join(" ")} failed with exit code ${result.status}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage:
  node scripts/install.mjs --profile <name> [--dry-run]
  node scripts/install.mjs --profile <name> --uninstall [--dry-run]

Options:
  --profile <name>  DSH profile to install into (desktop, web, or a profile you created)
  --uninstall       remove the plugin from that profile
  --dry-run         print the planned changes without running anything
  -h, --help        show this help
`);
  process.exit(0);
}

const repoManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
if (repoManifest.name !== PACKAGE_NAME) {
  fail(`expected package ${PACKAGE_NAME} at ${repoRoot}, found ${JSON.stringify(repoManifest.name)}`);
}
const bundlePatch = repoManifest.dsh?.bundle?.patch;
if (bundlePatch === undefined || !existsSync(path.resolve(repoRoot, bundlePatch))) {
  fail(`${PACKAGE_NAME} does not declare a readable dsh.bundle.patch`);
}

const profileDir = path.join(dshHome, "profiles", options.profile);
const before = state(profileDir);
const installed = before.dependency !== undefined;

console.log(`dsh-effort-lab installer${options.dryRun ? " (dry run)" : ""}`);
console.log(`  package: ${PACKAGE_NAME} ${repoManifest.version}`);
console.log(`  repo:    ${repoRoot}`);
console.log(`  profile: ${options.profile} (${profileDir})`);
console.log("");

if (options.uninstall) {
  if (!installed && !before.bundleListed) {
    console.log(`not installed in profile ${options.profile}; nothing to do.`);
    process.exit(0);
  }
  if (options.dryRun) {
    console.log(`dry-run: would run dsh plugin --profile ${options.profile} remove ${PACKAGE_NAME}`);
  } else {
    run(["remove", PACKAGE_NAME]);
    console.log(`Removed ${PACKAGE_NAME} from profile ${options.profile}. Restart DSH to unload it.`);
  }
  process.exit(0);
}

if (!existsSync(profileDir)) {
  fail(`profile ${options.profile} does not exist at ${profileDir}; use the profile you actually run`);
}

if (installed && before.bundleListed) {
  console.log(`Already installed in profile ${options.profile} (${before.dependency}); nothing to do.`);
  process.exit(0);
}

if (options.dryRun) {
  console.log(`dry-run: would run dsh plugin --profile ${options.profile} add ${repoRoot}`);
  process.exit(0);
}

run(["add", repoRoot]);

const after = state(profileDir);
if (after.dependency === undefined) {
  fail(`dsh plugin add finished but ${PACKAGE_NAME} is not in ${after.manifestPath}`);
}
if (!after.bundleListed) {
  fail(`dsh plugin add finished but ${PACKAGE_NAME} is missing from dsh.profile.bundles; uninstall then reinstall`);
}
console.log("");
console.log(`Installed ${PACKAGE_NAME} into profile ${options.profile}.`);
console.log("Next: restart DSH, then in a session run `/effort-lab start my-sweep`.");
