import debug from "debug";
import { existsSync } from "fs";
import { join } from "path";
import { APbot } from "./APbot";

const { PYTHON_PATH, AP_PATH } = process.env;

(async () => {
  console.debug = debug("debug");
  console.info = console.log = debug("info");
  console.warn = debug("warn");
  console.error = debug("error");

  if (!PYTHON_PATH)
    console.warn(
      "No Python path specified. Bot will not be able to run games."
    );
  if (!AP_PATH)
    console.warn(
      "No Archipelago path specified. Bot will not be able to run games."
    );
  else if (!existsSync(join(AP_PATH, "Generate.py")))
    console.warn(
      "Archipelago path provided seems to be missing files. Bot may not be able to run games."
    );

  new APbot();
})();
