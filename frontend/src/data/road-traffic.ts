import { listRows, reloadRows, saveRows } from './local-store'
import { MODULE_BY_KEY } from './modules'
import type {
  ActionResult,
  EntryRow,
  RoadAvoidance,
  RoadLedgerEntry,
  RoadMigrationState,
  RoadMigrationStatus,
} from './types'

// 林区道路通行规则的统一写法，全系统只认这一处：
// 1. 通行状态只能从这里改，行级 status 与「通行状态」字段永远同一次写入，
//    不会再出现同一路段既在施工清单又在可通行列表；
// 2. 每次变动先追加巡检台账（只增不改），历史巡检记录不会丢；
// 3. 施工与封闭互斥，同一路段只接受先到的请求，后来的一律拒绝。
export const ROAD_KEY = 'forestroad'

const roadMeta = MODULE_BY_KEY.get(ROAD_KEY)
if (!roadMeta) {
  throw new Error('林区道路模块没有登记')
}
const meta = roadMeta

// 施工/封闭是互斥占用态：进入其中一个后，另一个请求直接拒绝（先到者得）。
const EXCLUSIVE_STATUSES = ['正在施工', '禁止通行']
// 巡检类动作：刷新最近巡检日并把结果写回路段，供缺道路等级时按原巡检结果兼容。
const PATROL_ACTION = '安排巡检'

const LEDGER_KEY = 'forest-fire-patrol:road-ledger'
const MIGRATION_KEY = 'forest-fire-patrol:road-traffic-migration'

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function readLedger(): RoadLedgerEntry[] {
  const raw = storage()?.getItem(LEDGER_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as RoadLedgerEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLedger(entries: RoadLedgerEntry[]): void {
  storage()?.setItem(LEDGER_KEY, JSON.stringify(entries))
}

function readMigrationState(): RoadMigrationState {
  const fallback: RoadMigrationState = { doneIds: [], failures: [], completed: false, updatedAt: '' }
  const raw = storage()?.getItem(MIGRATION_KEY)
  if (!raw) {
    return fallback
  }
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<RoadMigrationState>) }
  } catch {
    return fallback
  }
}

function writeMigrationState(state: RoadMigrationState): void {
  storage()?.setItem(MIGRATION_KEY, JSON.stringify(state))
}

function nextLedgerId(entries: RoadLedgerEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1
}

function ledgerEntry(row: EntryRow, action: string, source: string, id: number): RoadLedgerEntry {
  return {
    id,
    路段id: Number(row.id),
    道路编号: String(row['道路编号'] ?? ''),
    动作: action,
    通行状态: String(row.status),
    巡检结果: String(row['巡检结果'] ?? ''),
    记录时间: new Date().toISOString(),
    来源: source,
  }
}

// 缺道路等级时的兼容顺序：路段自带的巡检结果 → 台账里该路段最近的巡检结果 → 未评级。
function compatGrade(row: EntryRow, ledger: RoadLedgerEntry[]): string {
  const fromRow = String(row['巡检结果'] ?? '').trim()
  if (fromRow !== '') {
    return fromRow
  }
  const roadId = Number(row.id)
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]
    if (Number(entry.路段id) === roadId && entry.巡检结果.trim() !== '') {
      return entry.巡检结果
    }
  }
  return '未评级'
}

// 回填单条存量路段：通行状态与 status 收拢为同一个值，缺等级按原巡检结果兼容；
// 道路编号只读，缺编号的路段不猜不补，直接记为失败等断点续跑。
function backfillRoadRow(row: EntryRow, ledger: RoadLedgerEntry[]): { row: EntryRow; changed: boolean } {
  if (String(row['道路编号'] ?? '').trim() === '') {
    throw new Error('缺少道路编号，不能回填')
  }
  const status = String(row.status ?? '').trim()
  if (!meta.statuses.includes(status)) {
    throw new Error(`通行状态「${status}」不在已登记的状态集合里`)
  }
  const next: EntryRow = { ...row, status, 通行状态: status }
  if (String(next['道路等级'] ?? '').trim() === '') {
    next['道路等级'] = compatGrade(next, ledger)
  }
  const changed = next['通行状态'] !== row['通行状态'] || next['道路等级'] !== row['道路等级']
  return { row: next, changed }
}

// 回填存量路段：断点续跑，每处理完一条就把断点落库；失败路段记下来，下次调用从断点继续。
export function migrateRoadTraffic(): RoadMigrationState {
  const state = readMigrationState()
  state.failures = []
  const failures = state.failures
  const rows = listRows(ROAD_KEY)
  const done = new Set(state.doneIds)
  const ledger = readLedger()
  const nextRows = [...rows]

  for (let index = 0; index < nextRows.length; index += 1) {
    const row = nextRows[index]
    const id = Number(row.id)
    if (done.has(id)) {
      continue
    }
    try {
      const result = backfillRoadRow(row, ledger)
      nextRows[index] = result.row
      if (result.changed) {
        ledger.push(ledgerEntry(result.row, '迁移回填', '通行规则迁移', nextLedgerId(ledger)))
      }
      done.add(id)
    } catch (error) {
      failures.push({
        id,
        道路编号: String(row['道路编号'] ?? ''),
        reason: error instanceof Error ? error.message : '回填失败',
      })
    }
    // 每一条都落一次断点，中途关掉页面也能从这里继续。
    saveRows(ROAD_KEY, nextRows)
    writeLedger(ledger)
    state.doneIds = [...done]
    state.completed = false
    state.updatedAt = new Date().toISOString()
    writeMigrationState(state)
  }

  state.doneIds = [...done]
  state.completed = failures.length === 0
  state.updatedAt = new Date().toISOString()
  writeMigrationState(state)
  return state
}

export function ensureRoadMigration(): void {
  if (!readMigrationState().completed) {
    migrateRoadTraffic()
  }
}

export function roadMigrationStatus(): RoadMigrationStatus {
  const state = readMigrationState()
  return { ...state, total: listRows(ROAD_KEY).length, migrated: state.doneIds.length }
}

// 通行状态的唯一写入口：先按最新数据判断互斥，再统一写字段、补台账。
export function applyRoadTrafficAction(id: number, action: string): ActionResult {
  ensureRoadMigration()
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 重新读最新数据再判断，别的页签先落库的施工/封闭能在这里被拦住。
  const rows = reloadRows(ROAD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (EXCLUSIVE_STATUSES.includes(current) && EXCLUSIVE_STATUSES.includes(target)) {
    return {
      ok: false,
      message: `道路「${String(row['道路编号'] ?? id)}」已按先到请求进入「${current}」，本次「${action}」被拒绝`,
    }
  }
  const updated: EntryRow = {
    ...row,
    status: target,
    通行状态: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: false,
  }
  if (action === PATROL_ACTION) {
    updated['最近巡检日'] = new Date().toISOString().slice(0, 10)
    updated['巡检结果'] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(ROAD_KEY, next)
  const ledger = readLedger()
  ledger.push(ledgerEntry(updated, action, '动作流转', nextLedgerId(ledger)))
  writeLedger(ledger)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 给无人机航线等入口的避让清单：正在施工或禁止通行的路段，读最新数据保证同步。
export function listRoadAvoidances(): RoadAvoidance[] {
  ensureRoadMigration()
  return reloadRows(ROAD_KEY)
    .filter((row) => EXCLUSIVE_STATUSES.includes(String(row.status)))
    .map((row) => ({
      道路编号: String(row['道路编号'] ?? ''),
      道路名称: String(row['道路名称'] ?? ''),
      起点位置: String(row['起点位置'] ?? ''),
      终点位置: String(row['终点位置'] ?? ''),
      通行状态: String(row.status),
    }))
}

export function listRoadLedger(roadId?: number): RoadLedgerEntry[] {
  const entries = readLedger()
  const filtered =
    roadId === undefined ? entries : entries.filter((entry) => Number(entry.路段id) === roadId)
  return [...filtered].sort((a, b) => b.id - a.id)
}

// 重置林区道路模块时连台账与迁移断点一起清，重新播种后会重新回填。
export function resetRoadTraffic(): void {
  storage()?.removeItem(LEDGER_KEY)
  storage()?.removeItem(MIGRATION_KEY)
}
