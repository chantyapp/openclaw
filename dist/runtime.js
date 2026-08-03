// Chanty plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const { setRuntime: setChantyRuntime, getRuntime: getChantyRuntime, tryGetRuntime: getOptionalChantyRuntime, } = createPluginRuntimeStore({
    pluginId: "chanty",
    errorMessage: "Chanty runtime not initialized",
});
export { getChantyRuntime, getOptionalChantyRuntime, setChantyRuntime };
