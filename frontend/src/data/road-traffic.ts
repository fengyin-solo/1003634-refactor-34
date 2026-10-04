import { listRows, refreshRows, saveRows } from './local-store'
import { MODULE_BY_KEY } from './modules'
import type {
  ActionResult,
  EntryRow,
  RoadClosureNotice,
  RoadLedgerEntry,
  RoadMigrationResult,
} from './types'

// 林区道路通行规则统一收拢在这一个文件里：
// 状态流转、巡检台账、存量回填、无人机避让提醒都从这里取结论，
// 任何入口不允许绕过这里直接改通行状态。
const ROAD_KEY = 'forestroad'
const LEDGER_STORAGE_KEY = 'forest-fire-patrol:road-ledger'
const MIGRATION_STORAGE_KEY = 'forest-fire-patrol:road-migration'

// 施工/封闭是「占位」请求：同一路段已有先到请求占住时，后来的请求直接拒绝。
const OCCUPYING_STATUSES = ['正在施工', '禁止通行']
const OCCUPYING_ACTIONS = ['登记施工', '封闭道路']

function roadMeta() {
  const meta = MODULE_BY_KEY.get(ROAD_KEY)
  if (!meta) {
    throw new Error(`没有登记名为 ${ROAD_KEY} 的业务模块`)
  }
  return meta
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------- 巡检台账：按道路编号挂账，只追加不覆盖，历史巡检记录不丢 ----------

function readLedger(): Record<string, RoadLedgerEntry[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(LEDGER_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, RoadLedgerEntry[]>
  } catch {
    return {}
  }
}

function writeLedger(ledger: Record<string, RoadLedgerEntry[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger))
  }
}

export function listRoadLedger(roadNo: string): RoadLedgerEntry[] {
  return clone(readLedger()[roadNo] ?? [])
}

function appendRoadLedger(roadNo: string, entry: RoadLedgerEntry): void {
  const ledger = readLedger()
  ledger[roadNo] = [...(ledger[roadNo] ?? []), entry]
  writeLedger(ledger)
}

// ---------- 统一通行规则 ----------

// 统一写法只有一个出口：已知状态原样采用；状态缺失时，缺道路等级的路段
// 按原巡检结果（通行状态字段）兼容，不重置成默认通行态。
export function resolveUnifiedStatus(row: EntryRow): { status: string; note: string } {
  const meta = roadMeta()
  const current = String(row.status ?? '')
  const gradeMissing = String(row['道路等级'] ?? '').trim() === ''
  if (meta.statuses.includes(current)) {
    return {
      status: current,
      note: gradeMissing ? '缺道路等级，按原巡检结果兼容' : '通行规则统一校准',
    }
  }
  if (gradeMissing) {
    const legacy = String(row['通行状态'] ?? '').trim()
    if (legacy) {
      return { status: legacy, note: '缺道路等级，沿用原巡检结果' }
    }
  }
  return { status: meta.statuses[0], note: '通行规则统一校准' }
}

// ---------- 存量回填：断点续迁，失败路段不进断点 ----------

type MigrationCheckpoint = { done: number[]; finished: boolean }

function readCheckpoint(): MigrationCheckpoint {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { done: [], finished: false }
  }
  const raw = window.localStorage.getItem(MIGRATION_STORAGE_KEY)
  if (!raw) {
    return { done: [], finished: false }
  }
  try {
    return JSON.parse(raw) as MigrationCheckpoint
  } catch {
    return { done: [], finished: false }
  }
}

function writeCheckpoint(checkpoint: MigrationCheckpoint): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MIGRATION_STORAGE_KEY, JSON.stringify(checkpoint))
  }
}

function isNormalized(row: EntryRow, status: string): boolean {
  return (
    String(row.status) === status &&
    String(row['通行状态'] ?? '') === status &&
    row.version !== undefined
  )
}

export function migrateForestRoads(): RoadMigrationResult {
  const checkpoint = readCheckpoint()
  const resumedFrom = checkpoint.done.length ? Math.max(...checkpoint.done) : null
  const rows = listRows(ROAD_KEY)
  const done = new Set(checkpoint.done)
  const failed: RoadMigrationResult['failed'] = []
  const next = [...rows]
  let migrated = 0
  let skipped = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const id = Number(row.id)
    const roadNo = String(row['道路编号'] ?? '').trim()
    if (!roadNo) {
      // 不能改道路编号：缺编号的路段挂不上台账，记为失败，等补登后从断点继续
      failed.push({ id, 道路编号: '', message: '缺道路编号，按约定不补编号，补登后重新迁移' })
      continue
    }
    const { status, note } = resolveUnifiedStatus(row)
    if (done.has(id) && isNormalized(row, status)) {
      skipped += 1
      continue
    }
    next[index] = {
      ...row,
      status,
      通行状态: status,
      version: Number(row.version ?? 0) + 1,
    }
    appendRoadLedger(roadNo, { 时间: today(), 动作: '存量回填', 结果: status, 备注: note })
    done.add(id)
    migrated += 1
  }
  saveRows(ROAD_KEY, next)
  const finished = failed.length === 0
  writeCheckpoint({ done: [...done], finished })
  return { total: rows.length, migrated, skipped, failed, finished, resumedFrom }
}

// 迁移没跑完就先补跑：迁移完成后施工/封闭才接受先到请求。
function ensureForestRoadMigration(): void {
  if (!readCheckpoint().finished) {
    migrateForestRoads()
  }
}

// ---------- 状态流转：并发施工与封闭只接受先到请求 ----------

export function runForestRoadAction(id: number, action: string): ActionResult {
  const meta = roadMeta()
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  ensureForestRoadMigration()
  const snapshot = listRows(ROAD_KEY).find((row) => Number(row.id) === id)
  if (!snapshot) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const expectedVersion = Number(snapshot.version ?? 0)
  // 重读持久层再校验：版本不一致说明别的入口已抢先改动，后到请求不能覆盖先到请求
  const fresh = refreshRows(ROAD_KEY)
  const current = fresh.find((row) => Number(row.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (Number(current.version ?? 0) !== expectedVersion) {
    return { ok: false, message: '该路段刚被其他入口变更，请刷新后重试' }
  }
  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (OCCUPYING_ACTIONS.includes(action) && OCCUPYING_STATUSES.includes(currentStatus)) {
    return { ok: false, message: `该路段已有先到的「${currentStatus}」请求，「${action}」未受理` }
  }
  const roadNo = String(current['道路编号'] ?? '').trim()
  if (!roadNo) {
    return { ok: false, message: '该路段缺道路编号，先补登编号再流转' }
  }
  const updated: EntryRow = {
    ...current,
    status: target,
    通行状态: target,
    version: expectedVersion + 1,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: false,
  }
  if (action === '安排巡检') {
    updated['最近巡检日'] = today()
  }
  saveRows(
    ROAD_KEY,
    fresh.map((row) => (Number(row.id) === id ? updated : row)),
  )
  appendRoadLedger(roadNo, { 时间: today(), 动作: action, 结果: target, 备注: '统一通行规则流转' })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------- 给其他入口的避让提醒 ----------

export function listRoadClosureNotices(): RoadClosureNotice[] {
  return listRows(ROAD_KEY)
    .filter((row) => OCCUPYING_STATUSES.includes(String(row.status)))
    .map((row) => ({
      id: Number(row.id),
      道路编号: String(row['道路编号'] ?? ''),
      道路名称: String(row['道路名称'] ?? ''),
      起点位置: String(row['起点位置'] ?? ''),
      终点位置: String(row['终点位置'] ?? ''),
      status: String(row.status),
    }))
}
