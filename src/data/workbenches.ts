import type { WorkbenchDef, Faction } from "../types/index";

export const WORKBENCH_DEFS: WorkbenchDef[] = [
  {
    type: "Kleidung",
    baseClassname: "Exodus_WB_Kleidung",
    tools: [
      { classname: "Exodus_WB_Tool_Schere", label: "Schere" },
      { classname: "Exodus_WB_Tool_Keksdose", label: "Keksdose" },
      { classname: "Exodus_WB_Tool_Naehmaschine", label: "Nähmaschine" },
    ],
  },
  {
    type: "Medizin",
    baseClassname: "Exodus_WB_Medizin",
    tools: [
      { classname: "Exodus_WB_Tool_Brenner", label: "Brenner" },
      { classname: "Exodus_WB_Tool_Mikroskop", label: "Mikroskop" },
      { classname: "Exodus_WB_Tool_Diagnose", label: "Diagnose" },
    ],
  },
  {
    type: "Waffen",
    baseClassname: "Exodus_WB_Waffen",
    tools: [
      { classname: "Exodus_WB_Tool_Schraubstock", label: "Schraubstock" },
      { classname: "Exodus_WB_Tool_Schleifer", label: "Schleifer" },
      { classname: "Exodus_WB_Tool_Drehbank", label: "Drehbank" },
    ],
  },
  {
    type: "Werkbank",
    baseClassname: "Exodus_WB_Werkbank",
    tools: [
      { classname: "Exodus_WB_Tool_Amboss", label: "Amboss" },
      { classname: "Exodus_WB_Tool_Bohrer", label: "Bohrer" },
      { classname: "Exodus_WB_Tool_Schweisser", label: "Schweißer" },
    ],
  },
  {
    type: "Wissenschaft",
    baseClassname: "Exodus_WB_Wissenschaft",
    tools: [
      { classname: "Exodus_WB_Tool_Loetkolben", label: "Lötkolben" },
      { classname: "Exodus_WB_Tool_Computer", label: "Computer" },
      { classname: "Exodus_WB_Tool_Antenne", label: "Antenne" },
    ],
  },
];

export const FACTIONS: Faction[] = [
  "Badnits",
  "ClearSky",
  "Digger",
  "Duty",
  "Ecologist",
  "Freedom",
  "FreeStalker",
  "IPSF",
  "Loner",
  "Mercenary",
  "Military",
  "Monoltih",
  "Noontide",
  "Spark",
  "UNISG",
  "Warden",
];

export function getWorkbenchClassname(
  type: string,
  faction?: string | null
): string {
  const base = WORKBENCH_DEFS.find((w) => w.type === type)?.baseClassname ?? `Exodus_WB_${type}`;
  if (!faction) return base;
  return `${base}_${faction}`;
}

export function getWorkbenchDef(type: string): WorkbenchDef | undefined {
  return WORKBENCH_DEFS.find((w) => w.type === type);
}
