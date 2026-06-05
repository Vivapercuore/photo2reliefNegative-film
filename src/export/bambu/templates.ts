/**
 * Static OPC/Bambu parts that don't depend on the mesh.
 *
 * A Bambu `.3mf` is an OPC (Open Packaging Conventions) ZIP. The big,
 * feature-specific 工艺参数 (`project_settings.config` / `filament_settings_1.config`)
 * live under `public/bambu/<feature>/` so they can be swapped by simply
 * replacing a file with your own Bambu Studio export — see fetchProcessConfig().
 */

/** `[Content_Types].xml` — MIME map for the package. */
export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;

/**
 * `_rels/.rels` — root relationships. We inline the mesh in 3dmodel.model
 * (no production-extension split), so this only needs to point at the model.
 */
export const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** `Metadata/slice_info.config` — slicer client header Bambu expects. */
export const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.04.00.70"/>
  </header>
</config>`;

/**
 * 项目信息 written into 3dmodel.model's <metadata> block. Mirrors the fields
 * Bambu Studio emits; the sample's foreign cloud IDs (DesignModelId,
 * MakerLabFileId, DesignerUserId …) are intentionally omitted — supply your
 * own via `extra` only if you legitimately own them.
 */
export interface BambuProjectMeta {
  /** 3MF Title — shown as the project name in the slicer. */
  title: string;
  /** Designer / author name (optional). */
  designer?: string;
  /** Free-text description (optional). */
  description?: string;
  /** Copyright / license string (optional). */
  license?: string;
  /** App string written as `Application` (defaults to photo2relief). */
  application?: string;
  /**
   * Any additional `<metadata name=...>` pairs to emit verbatim — use this to
   * carry your *own* Bambu/MakerWorld project IDs once you have them.
   */
  extra?: Record<string, string>;
}

/** `YYYY-MM-DD` for the CreationDate/ModificationDate metadata. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
