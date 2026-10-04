/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 林区道路巡检台账的一条记录：每次流转、每次存量回填都追加，历史不覆盖。 */
export type RoadLedgerEntry = {
  时间: string
  动作: string
  结果: string
  备注: string
}

export type RoadMigrationFailure = {
  id: number
  道路编号: string
  message: string
}

/** 存量路段回填结果：失败路段不进断点，重跑时从断点继续。 */
export type RoadMigrationResult = {
  total: number
  migrated: number
  skipped: number
  failed: RoadMigrationFailure[]
  finished: boolean
  resumedFrom: number | null
}

/** 给无人机等其他入口用的航线避让提醒：施工/封闭中的路段。 */
export type RoadClosureNotice = {
  id: number
  道路编号: string
  道路名称: string
  起点位置: string
  终点位置: string
  status: string
}
