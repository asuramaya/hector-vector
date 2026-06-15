// Shared document-selection state — extracted from app.js (#28 detangle). The few
// mutable values that the library, data-sync, doc-IO, viewport and export layers all
// read AND write: which work-item/output is selected, the manual output override, and
// the cached library/outputs/projects lists. Owning them here (as live bindings +
// setters) is what lets those layers become independent modules instead of sharing
// app.js's lexical scope. Reads use the live bindings directly; writes go through the
// setters (ESM imports are read-only by name).
//
// NOT here: `viewports` (a const object, mutated in place, never reassigned — imported
// by reference like settings/prefs) and `workspace` (settings-owned).

export let workItems = [];      // library source images (GET /work-items)
export let outputs = [];        // produced files (GET /outputs)
export let projects = [];       // saved .hv projects (Canvas tab)
export let selectedName = null;     // selected work-item name (the library cursor)
export let selectedOutput = null;   // the active output/save target ({name,folder,url,kind,path} | null)
export let manualOutputName = null; // explicit output override (beats preferredOutput)

export function setWorkItems(v) { workItems = v; }
export function setOutputs(v) { outputs = v; }
export function setProjects(v) { projects = v; }
export function setSelectedName(v) { selectedName = v; }
export function setSelectedOutput(v) { selectedOutput = v; }
export function setManualOutputName(v) { manualOutputName = v; }
