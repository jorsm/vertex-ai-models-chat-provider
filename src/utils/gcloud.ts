import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface GcloudCommand { executable: string; args: string[]; direct: boolean }

/** Prefer the SDK's Python on Windows: no batch launcher or interpreter probes. */
export function resolveGcloudCommand(args: string[], platform = process.platform, env = process.env,
  exists = fs.existsSync): GcloudCommand {
  if (platform !== "win32") { return { executable: "gcloud", args, direct: true }; }
  const winPath = path.win32;
  const sdkBin = (env.PATH ?? env.Path ?? "").split(";").map((entry) => entry.replace(/^"|"$/g, ""))
    .find((entry) => entry && exists(winPath.join(entry, "gcloud.cmd")));
  if (sdkBin && !env.CLOUDSDK_PYTHON && !env.CLOUDSDK_PYTHON_ARGS && !env.CLOUDSDK_USE_GOCLOUD) {
    const root = env.CLOUDSDK_ROOT_DIR || winPath.resolve(sdkBin, "..");
    const python = winPath.join(root, "platform", "bundledpython", "python.exe");
    const script = winPath.join(root, "lib", "gcloud.py");
    if (exists(python) && exists(script)) {
      const isolated = !env.CLOUDSDK_PYTHON_SITEPACKAGES && !env.VIRTUAL_ENV ? ["-S"] : [];
      return { executable: python, args: [...isolated, script, ...args], direct: true };
    }
  }
  // Callers supply only fixed CLI arguments, never user input.
  return { executable: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `gcloud.cmd ${args.join(" ")}`], direct: false };
}

export function runGcloud(args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "true", CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true",
    CLOUDSDK_CORE_LOG_HTTP: "false", CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true" };
  const command = resolveGcloudCommand(args, process.platform, env);
  if (process.platform === "win32" && command.direct) {
    delete env.PYTHONHOME;
    if (env.CLOUDSDK_ENCODING) { env.PYTHONIOENCODING = env.CLOUDSDK_ENCODING; }
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let child: childProcess.ChildProcess | undefined;
    const timer = setTimeout(() => {
      if (finished) { return; }
      finished = true;
      const error = Object.assign(new Error("gcloud timed out"), { code: "GCLOUD_TIMEOUT", killed: true });
      if (process.platform === "win32" && !command.direct && child?.pid) {
        // Killing cmd.exe alone leaves Python holding the output pipes open.
        childProcess.execFile("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 2_000 }, () => reject(error));
      } else {
        child?.kill("SIGKILL");
        reject(error);
      }
    }, timeoutMs);
    child = childProcess.execFile(command.executable, command.args,
      // Our deadline kills the entire launcher tree before rejecting. A native
      // execFile timeout would race it by killing only cmd.exe first.
      { encoding: "utf8", maxBuffer: 64 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
        if (finished) { return; }
        finished = true;
        clearTimeout(timer);
        if (error) { reject(error); } else { resolve({ stdout, stderr }); }
      });
    // Authentication probes are noninteractive, including at extension startup.
    child?.stdin?.end();
  });
}
