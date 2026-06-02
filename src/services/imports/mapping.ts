import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/repositories/queryable.js'

export type ColumnMapping = Record<string, string>

export interface ImportMappingPreset {
  id: string
  orgId: string
  name: string
  version: number
  columnMappings: ColumnMapping
  createdAt: Date
  updatedAt: Date
}

export interface CreateMappingPresetInput {
  orgId: string
  name: string
  columnMappings: ColumnMapping
}

export interface UpdateMappingPresetInput {
  name?: string
  columnMappings?: ColumnMapping
}

interface PresetRow {
  id: string
  org_id: string
  name: string
  version: number
  column_mappings: ColumnMapping
  created_at: Date
  updated_at: Date
}

function mapRow(row: PresetRow): ImportMappingPreset {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    version: row.version,
    columnMappings: row.column_mappings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MappingPresetRepository {
  constructor(private readonly db: Queryable) {}

  async findByOrg(orgId: string): Promise<ImportMappingPreset[]> {
    const result = await this.db.query<PresetRow>(
      `SELECT id, org_id, name, version, column_mappings, created_at, updated_at
       FROM import_mapping_presets
       WHERE org_id = $1
       ORDER BY name, version DESC`,
      [orgId],
    )
    return result.rows.map(mapRow)
  }

  async findById(id: string): Promise<ImportMappingPreset | null> {
    const result = await this.db.query<PresetRow>(
      `SELECT id, org_id, name, version, column_mappings, created_at, updated_at
       FROM import_mapping_presets
       WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async create(input: CreateMappingPresetInput): Promise<ImportMappingPreset> {
    const id = randomUUID()
    const existing = await this.db.query<{ max_version: number | null }>(
      `SELECT MAX(version) AS max_version
       FROM import_mapping_presets
       WHERE org_id = $1 AND name = $2`,
      [input.orgId, input.name],
    )
    const nextVersion = (existing.rows[0]?.max_version ?? 0) + 1

    const result = await this.db.query<PresetRow>(
      `INSERT INTO import_mapping_presets (id, org_id, name, version, column_mappings)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, org_id, name, version, column_mappings, created_at, updated_at`,
      [id, input.orgId, input.name, nextVersion, JSON.stringify(input.columnMappings)],
    )
    return mapRow(result.rows[0])
  }

  async update(id: string, input: UpdateMappingPresetInput): Promise<ImportMappingPreset | null> {
    const sets: string[] = []
    const params: unknown[] = []
    let paramIdx = 1

    if (input.name !== undefined) {
      sets.push(`name = $${paramIdx++}`)
      params.push(input.name)
    }
    if (input.columnMappings !== undefined) {
      sets.push(`column_mappings = $${paramIdx++}`)
      params.push(JSON.stringify(input.columnMappings))
    }

    if (sets.length === 0) {
      return this.findById(id)
    }

    sets.push(`version = version + 1`)
    sets.push(`updated_at = NOW()`)

    params.push(id)
    const result = await this.db.query<PresetRow>(
      `UPDATE import_mapping_presets
       SET ${sets.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, org_id, name, version, column_mappings, created_at, updated_at`,
      params,
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM import_mapping_presets WHERE id = $1`,
      [id],
    )
    return (result.rowCount ?? 0) > 0
  }
}

export class InMemoryMappingPresetRepository {
  private presets: ImportMappingPreset[] = []

  async findByOrg(orgId: string): Promise<ImportMappingPreset[]> {
    return this.presets
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version)
  }

  async findById(id: string): Promise<ImportMappingPreset | null> {
    return this.presets.find((p) => p.id === id) ?? null
  }

  async create(input: CreateMappingPresetInput): Promise<ImportMappingPreset> {
    const existing = this.presets
      .filter((p) => p.orgId === input.orgId && p.name === input.name)
      .reduce((max, p) => Math.max(max, p.version), 0)
    const nextVersion = existing + 1

    const preset: ImportMappingPreset = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name,
      version: nextVersion,
      columnMappings: { ...input.columnMappings },
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.presets.push(preset)
    return { ...preset, columnMappings: { ...preset.columnMappings } }
  }

  async update(id: string, input: UpdateMappingPresetInput): Promise<ImportMappingPreset | null> {
    const idx = this.presets.findIndex((p) => p.id === id)
    if (idx === -1) return null

    const preset = this.presets[idx]
    let changed = false
    if (input.name !== undefined) { preset.name = input.name; changed = true }
    if (input.columnMappings !== undefined) { preset.columnMappings = { ...input.columnMappings }; changed = true }

    if (!changed) {
      return { ...preset, columnMappings: { ...preset.columnMappings } }
    }

    preset.version += 1
    preset.updatedAt = new Date()
    this.presets[idx] = { ...preset, columnMappings: { ...preset.columnMappings } }
    return { ...preset, columnMappings: { ...preset.columnMappings } }
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.presets.findIndex((p) => p.id === id)
    if (idx === -1) return false
    this.presets.splice(idx, 1)
    return true
  }

  clear(): void {
    this.presets = []
  }
}

const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

function sanitizeCellValue(value: string): string {
  if (value.length > 0 && FORMULA_INJECTION_PREFIXES.has(value[0])) {
    return `\t${value}`
  }
  return value
}

export function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1)
  }
  return text
}

export function buildColumnMapper(
  csvHeaders: string[],
  columnMappings: ColumnMapping,
): (row: string[]) => Record<string, string> {
  const normalizedHeaders = csvHeaders.map((h) => stripBom(h).toLowerCase())

  const canonicalToCsvIndex = new Map<string, number>()

  for (const [csvHeader, canonicalColumn] of Object.entries(columnMappings)) {
    const normalizedCsv = csvHeader.toLowerCase()
    const idx = normalizedHeaders.indexOf(normalizedCsv)
    if (idx !== -1) {
      canonicalToCsvIndex.set(canonicalColumn, idx)
    }
  }

  return (row: string[]): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const [canonical, csvIdx] of canonicalToCsvIndex) {
      const raw = csvIdx < row.length ? row[csvIdx] : ''
      result[canonical] = sanitizeCellValue(raw !== undefined ? String(raw).trim() : '')
    }
    return result
  }
}

export function applyPresetToPreview(
  rawRows: string[][],
  csvHeaders: string[],
  columnMappings: ColumnMapping,
): Array<{ remapped: Record<string, string>; line: number }> {
  const mapper = buildColumnMapper(csvHeaders, columnMappings)
  return rawRows.map((row, idx) => ({
    remapped: mapper(row),
    line: idx + 2,
  }))
}
