/**
 * Fails (exit 1) if renderDemo() drifts from the checked-in DEMO_OUTPUT.
 */
import { renderDemo } from "../src/demo.js";
import { DEMO_OUTPUT } from "../src/demo-output.js";

const actual = await renderDemo();
if (actual !== DEMO_OUTPUT) {
  console.error("DEMO OUTPUT DRIFT");
  console.error("--- expected ---");
  console.error(DEMO_OUTPUT);
  console.error("--- actual ---");
  console.error(actual);
  process.exit(1);
}
console.log("DEMO_OK");
