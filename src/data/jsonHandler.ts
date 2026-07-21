import type { WorkbenchJSON, CraftItem, ValidationIssue } from "../types/index";

export function validateJSON(data: unknown): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  if (typeof data !== "object" || data === null) {
    return { valid: false, issues: [{ id: "root", severity: "error", message: "Ungültiges JSON-Root-Objekt" }] };
  }

  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.WorkbenchesClassnames)) {
    issues.push({ id: "wb", severity: "error", message: "WorkbenchesClassnames fehlt oder ist kein Array" });
  }

  if (!Array.isArray(d.CraftCategories)) {
    issues.push({ id: "cat", severity: "error", message: "CraftCategories fehlt oder ist kein Array" });
  } else {
    const cats = d.CraftCategories as unknown[];
    cats.forEach((cat: unknown, ci: number) => {
      if (typeof cat !== "object" || cat === null) {
        issues.push({ id: `cat_${ci}`, severity: "error", message: `Kategorie ${ci}: kein Objekt` });
        return;
      }
      const c = cat as Record<string, unknown>;
      if (typeof c.CategoryName !== "string") {
        issues.push({ id: `cat_${ci}_name`, severity: "warning", message: `Kategorie ${ci}: CategoryName fehlt` });
      }
      if (!Array.isArray(c.CraftItems)) {
        issues.push({ id: `cat_${ci}_items`, severity: "error", message: `Kategorie ${c.CategoryName ?? ci}: CraftItems fehlt` });
      } else {
        (c.CraftItems as unknown[]).forEach((item: unknown, ii: number) => {
          validateCraftItem(item, `${c.CategoryName ?? ci}[${ii}]`, issues);
        });
      }
    });
  }

  if (typeof d.m_CustomizationSetting !== "object") {
    issues.push({ id: "custom", severity: "warning", message: "m_CustomizationSetting fehlt" });
  }

  return { valid: issues.filter(i => i.severity === "error").length === 0, issues };
}

function validateCraftItem(item: unknown, label: string, issues: ValidationIssue[]): void {
  if (typeof item !== "object" || item === null) {
    issues.push({ id: label, severity: "error", message: `${label}: kein Objekt` });
    return;
  }
  const it = item as Record<string, unknown>;

  if (!it.Result) issues.push({ id: `${label}_result`, severity: "error", message: `${label}: Result fehlt` });
  if (!it.RecipeName) issues.push({ id: `${label}_name`, severity: "warning", message: `${label}: RecipeName fehlt` });
  if (!Array.isArray(it.CraftComponents) || (it.CraftComponents as unknown[]).length === 0) {
    issues.push({ id: `${label}_components`, severity: "warning", message: `${label}: CraftComponents leer oder fehlt` });
  }
  if (!Array.isArray(it.AttachmentsNeed)) {
    issues.push({ id: `${label}_attachments`, severity: "warning", message: `${label}: AttachmentsNeed fehlt` });
  }
}

export function parseJSON(raw: string): WorkbenchJSON | null {
  try {
    const parsed = JSON.parse(raw);
    const { valid } = validateJSON(parsed);
    if (!valid) return null;
    return normalizeJSON(parsed);
  } catch {
    return null;
  }
}

export function normalizeJSON(data: Record<string, unknown>): WorkbenchJSON {
  const cats = (Array.isArray(data.CraftCategories) ? data.CraftCategories : []) as Array<Record<string, unknown>>;
  return {
    WorkbenchesClassnames: Array.isArray(data.WorkbenchesClassnames) ? data.WorkbenchesClassnames as string[] : [],
    CraftCategories: cats.map(cat => ({
      CategoryName: String(cat.CategoryName ?? ""),
      CraftItems: Array.isArray(cat.CraftItems)
        ? (cat.CraftItems as Array<Record<string, unknown>>).map(normalizeCraftItem)
        : [],
    })),
    m_CustomizationSetting: {
      PathToMainBackgroundImg: String(
        (data.m_CustomizationSetting as Record<string, unknown>)?.PathToMainBackgroundImg ?? ""
      ),
      PathToCraftImg: String(
        (data.m_CustomizationSetting as Record<string, unknown>)?.PathToCraftImg ?? ""
      ),
    },
  };
}

function normalizeCraftItem(it: Record<string, unknown>): CraftItem {
  return {
    Result: String(it.Result ?? ""),
    ResultShow: String(it.ResultShow ?? it.Result ?? ""),
    ResultCount: Number(it.ResultCount ?? 1),
    ComponentsDontAffectHealth: Number(it.ComponentsDontAffectHealth ?? 0),
    CraftType: (["craft", "disassemble", "repair"].includes(String(it.CraftType)) ? it.CraftType : "craft") as CraftItem["CraftType"],
    RecipeName: String(it.RecipeName ?? ""),
    CraftComponents: Array.isArray(it.CraftComponents)
      ? (it.CraftComponents as Array<Record<string, unknown>>).map(c => ({
          Classname: String(c.Classname ?? ""),
          Amount: Number(c.Amount ?? 1),
          Destroy: Boolean(c.Destroy ?? true),
          Changehealth: Number(c.Changehealth ?? 0),
        }))
      : [],
    AttachmentsNeed: Array.isArray(it.AttachmentsNeed) ? it.AttachmentsNeed as string[] : [],
  };
}

export function downloadFile(content: string, filename: string, mime = "application/json"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Compress an image to max 128×128px JPEG for Firebase storage.
 * Typical result: 3-15 KB instead of 100-500 KB.
 * Still looks good in the 64×64px node thumbnails and 200×200px hover tooltip.
 */
export function compressImage(dataUrl: string, maxSize = 128, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // Scale down preserving aspect ratio
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round((height / width) * maxSize);
          width  = maxSize;
        } else {
          width  = Math.round((width / height) * maxSize);
          height = maxSize;
        }
      }
      canvas.width  = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      // White background for PNGs with transparency
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback: return original
    img.src = dataUrl;
  });
}
