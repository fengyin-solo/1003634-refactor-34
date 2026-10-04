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

// 林区道路巡检台账：只增不改，每次通行状态变动都追加一条，历史巡检记录因此不会丢。
export type RoadLedgerEntry = {
  id: number
  路段id: number
  道路编号: string
  动作: string
  通行状态: string
  巡检结果: string
  记录时间: string
  来源: string
}

export type RoadMigrationFailure = {
  id: number
  道路编号: string
  reason: string
}

// 存量路段回填的断点状态：doneIds 之外的段落下次接着跑，失败段落记录在 failures 里。
export type RoadMigrationState = {
  doneIds: number[]
  failures: RoadMigrationFailure[]
  completed: boolean
  updatedAt: string
}

export type RoadMigrationStatus = RoadMigrationState & {
  total: number
  migrated: number
}

// 给无人机航线等入口的避让提醒：正在施工或禁止通行的路段。
export type RoadAvoidance = {
  道路编号: string
  道路名称: string
  起点位置: string
  终点位置: string
  通行状态: string
}
