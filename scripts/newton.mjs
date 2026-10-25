// Set up and run the local Newton physics server (server/newton).
//   npm run newton:setup          create .venv-newton and install requirements
//   npm run newton -- --device cpu   start the server (extra args go to server.py)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const venv = join(root, ".venv-newton");
const venvPython = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
const [command = "serve", ...args] = process.argv.slice(2);

function run(exe, argv) {
  const result = spawnSync(exe, argv, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** First Python 3.11–3.13 on PATH (Newton's supported range). */
function systemPython() {
  for (const exe of [process.env.PYTHON, "python3", "python", "py"].filter(Boolean)) {
    const probe = spawnSync(exe, ["-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], { encoding: "utf8" });
    const version = Number(probe.stdout?.trim());
    if (probe.status === 0 && version >= 311 && version <= 313) return exe;
  }
  console.error("Python 3.11–3.13을 찾을 수 없습니다. 설치 후 다시 실행하거나 PYTHON 환경 변수로 지정하세요.");
  process.exit(1);
}

if (command === "setup") {
  if (!existsSync(venvPython)) run(systemPython(), ["-m", "venv", venv]);
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPython, ["-m", "pip", "install", "-r", join(root, "server", "newton", "requirements.txt")]);
  console.log("\nNewton 서버 준비 완료. `npm run newton`으로 실행하세요.");
} else if (command === "serve") {
  if (!existsSync(venvPython)) {
    console.error("Newton 가상 환경이 없습니다. 먼저 `npm run newton:setup`을 실행하세요.");
    process.exit(1);
  }
  const child = spawn(venvPython, [join(root, "server", "newton", "server.py"), ...args], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  console.error(`알 수 없는 명령: ${command} (setup | serve)`);
  process.exit(1);
}
