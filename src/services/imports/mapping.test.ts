import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryMappingPresetRepository,
  buildColumnMapper,
  stripBom,
  applyPresetToPreview,
  type ColumnMapping,
  type CreateMappingPresetInput,
} from './mapping.js'

// ===========================================================================
// InMemoryMappingPresetRepository
// ===========================================================================

describe('InMemoryMappingPresetRepository', () => {
  let repo: InMemoryMappingPresetRepository

  beforeEach(() => {
    repo = new InMemoryMappingPresetRepository()
  })

  const orgA = 'org-a-uuid'
  const orgB = 'org-b-uuid'

  describe('create', () => {
    it('creates a preset and assigns version 1', async () => {
      const preset = await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet Address': 'address' },
      })

      expect(preset.id).toBeDefined()
      expect(preset.orgId).toBe(orgA)
      expect(preset.name).toBe('Standard')
      expect(preset.version).toBe(1)
      expect(preset.columnMappings).toEqual({ 'Wallet Address': 'address' })
      expect(preset.createdAt).toBeInstanceOf(Date)
      expect(preset.updatedAt).toBeInstanceOf(Date)
    })

    it('increments version when a preset with the same org+name exists', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const v2 = await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address', 'Email': 'email' },
      })

      expect(v2.version).toBe(2)
    })

    it('does not increment version across different orgs', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const other = await repo.create({
        orgId: orgB,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })

      expect(other.version).toBe(1)
    })

    it('does not increment version across different names in same org', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const other = await repo.create({
        orgId: orgA,
        name: 'Advanced',
        columnMappings: { 'Wallet': 'address' },
      })

      expect(other.version).toBe(1)
    })
  })

  describe('findByOrg', () => {
    it('returns empty array for org with no presets', async () => {
      const presets = await repo.findByOrg('nonexistent-org')
      expect(presets).toEqual([])
    })

    it('returns all presets for a given org', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Alpha',
        columnMappings: { 'A': 'address' },
      })
      await repo.create({
        orgId: orgA,
        name: 'Beta',
        columnMappings: { 'B': 'address' },
      })
      await repo.create({
        orgId: orgB,
        name: 'Gamma',
        columnMappings: { 'C': 'address' },
      })

      const orgAPresets = await repo.findByOrg(orgA)
      expect(orgAPresets).toHaveLength(2)
      expect(orgAPresets.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta'])
    })

    it('returns multiple versions sorted by version DESC', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'W': 'address' },
      })
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'W': 'address', 'E': 'email' },
      })

      const presets = await repo.findByOrg(orgA)
      const stdPresets = presets.filter((p) => p.name === 'Standard')
      expect(stdPresets).toHaveLength(2)
      expect(stdPresets[0].version).toBe(2)
      expect(stdPresets[1].version).toBe(1)
    })
  })

  describe('findById', () => {
    it('returns null for nonexistent id', async () => {
      const preset = await repo.findById('nonexistent')
      expect(preset).toBeNull()
    })

    it('returns the preset by id', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'X': 'address' },
      })

      const found = await repo.findById(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe('Test')
    })
  })

  describe('update', () => {
    it('updates name and bumps version', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Original',
        columnMappings: { 'W': 'address' },
      })

      const updated = await repo.update(created.id, { name: 'Renamed' })
      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('Renamed')
      expect(updated!.version).toBe(2)
    })

    it('updates columnMappings and bumps version', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'W': 'address' },
      })

      const updated = await repo.update(created.id, {
        columnMappings: { 'W': 'address', 'E': 'email' },
      })
      expect(updated!.columnMappings).toEqual({ 'W': 'address', 'E': 'email' })
      expect(updated!.version).toBe(2)
    })

    it('returns null for nonexistent id', async () => {
      const result = await repo.update('nonexistent', { name: 'Nope' })
      expect(result).toBeNull()
    })

    it('returns the preset unchanged when no fields provided', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'W': 'address' },
      })
      const updated = await repo.update(created.id, {})
      expect(updated!.name).toBe('Test')
      expect(updated!.version).toBe(1)
    })
  })

  describe('delete', () => {
    it('returns true when a preset is deleted', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'ToDelete',
        columnMappings: { 'W': 'address' },
      })

      const deleted = await repo.delete(created.id)
      expect(deleted).toBe(true)

      const found = await repo.findById(created.id)
      expect(found).toBeNull()
    })

    it('returns false for nonexistent id', async () => {
      const result = await repo.delete('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all presets', async () => {
      await repo.create({
        orgId: orgA,
        name: 'A',
        columnMappings: {},
      })
      await repo.create({
        orgId: orgA,
        name: 'B',
        columnMappings: {},
      })

      repo.clear()
      const presets = await repo.findByOrg(orgA)
      expect(presets).toHaveLength(0)
    })
  })
})

// ===========================================================================
// stripBom
// ===========================================================================

describe('stripBom', () => {
  it('removes BOM from the start of a string', () => {
    const result = stripBom('\uFEFFaddress,name')
    expect(result).toBe('address,name')
  })

  it('returns the string unchanged when no BOM is present', () => {
    const result = stripBom('address,name')
    expect(result).toBe('address,name')
  })

  it('handles empty string', () => {
    expect(stripBom('')).toBe('')
  })

  it('does not strip non-BOM characters', () => {
    const result = stripBom('\uFEFF')
    expect(result).toBe('')
  })
})

// ===========================================================================
// buildColumnMapper
// ===========================================================================

describe('buildColumnMapper', () => {
  it('maps CSV columns to canonical columns using the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name', 'Email Address'],
      { 'Wallet Address': 'address', 'Full Name': 'name', 'Email Address': 'email' },
    )

    const result = mapper(['GB1234...', 'Alice', 'alice@example.com'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
      email: 'alice@example.com',
    })
  })

  it('matches headers case-insensitively', () => {
    const mapper = buildColumnMapper(
      ['WALLET ADDRESS', 'full name'],
      { 'wallet address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
    })
  })

  it('strips BOM from the first header', () => {
    const mapper = buildColumnMapper(
      ['\uFEFFWallet Address', 'Full Name'],
      { 'Wallet Address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
    })
  })

  it('maps only columns present in the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name', 'Phone'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...', 'Alice', '555-0100'])
    expect(result).toEqual({
      address: 'GB1234...',
    })
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('handles empty mapping gracefully', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name'],
      {},
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({})
  })

  it('when multiple mappings target the same canonical column the last CSV header wins', () => {
    const mapper = buildColumnMapper(
      ['Primary Wallet', 'Secondary Wallet'],
      { 'Primary Wallet': 'address', 'Secondary Wallet': 'address' },
    )

    const result = mapper(['GB1111...', 'GB2222...'])
    expect(result).toEqual({
      address: 'GB2222...',
    })
  })

  it('returns empty string for CSV columns that are missing in a row', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name'],
      { 'Wallet Address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: '',
    })
  })

  it('sanitizes formula-injection prefixes in cell values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['=SUM(A1:A10)'])
    expect(result.address).toBe('\t=SUM(A1:A10)')
  })

  it('sanitizes multiple formula-injection prefixes', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Notes'],
      { 'Wallet Address': 'address', 'Notes': 'notes' },
    )

    const result = mapper(['=cmd', '+expression'])
    expect(result.address).toBe('\t=cmd')
    expect(result.notes).toBe('\t+expression')
  })

  it('does not sanitize normal values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...'])
    expect(result.address).toBe('GB1234...')
  })

  it('trims whitespace from cell values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['  GB1234...  '])
    expect(result.address).toBe('GB1234...')
  })

  it('handles CSV headers that are not in the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Extra Column'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...', 'extra'])
    expect(result).toEqual({ address: 'GB1234...' })
  })

  it('returns empty result when no CSV headers match the mapping', () => {
    const mapper = buildColumnMapper(
      ['Col A', 'Col B'],
      { 'Wallet': 'address', 'Email': 'email' },
    )

    const result = mapper(['val1', 'val2'])
    expect(result).toEqual({})
  })
})

// ===========================================================================
// applyPresetToPreview
// ===========================================================================

describe('applyPresetToPreview', () => {
  it('remaps raw rows according to column mappings', () => {
    const csvHeaders = ['Wallet', 'Email']
    const columnMappings: ColumnMapping = { 'Wallet': 'address', 'Email': 'email' }
    const rawRows = [
      ['GB1111...', 'alice@test.com'],
      ['GB2222...', 'bob@test.com'],
    ]

    const result = applyPresetToPreview(rawRows, csvHeaders, columnMappings)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      remapped: { address: 'GB1111...', email: 'alice@test.com' },
      line: 2,
    })
    expect(result[1]).toEqual({
      remapped: { address: 'GB2222...', email: 'bob@test.com' },
      line: 3,
    })
  })

  it('handles empty rows array', () => {
    const result = applyPresetToPreview([], ['Wallet'], { 'Wallet': 'address' })
    expect(result).toEqual([])
  })

  it('sanitizes formula injection in applyPresetToPreview', () => {
    const csvHeaders = ['Wallet']
    const columnMappings: ColumnMapping = { 'Wallet': 'address' }
    const rawRows = [['=EVIL']]

    const result = applyPresetToPreview(rawRows, csvHeaders, columnMappings)
    expect(result[0].remapped.address).toBe('\t=EVIL')
  })

  it('assigns correct line numbers (2-indexed)', () => {
    const rawRows = [['a'], ['b'], ['c']]
    const result = applyPresetToPreview(rawRows, ['H1'], { 'H1': 'col1' })
    expect(result.map((r) => r.line)).toEqual([2, 3, 4])
  })
})
