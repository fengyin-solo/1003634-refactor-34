<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路管理</h2>
        <p class="page-desc">维护林区道路，围绕道路编号、道路名称、起点位置、终点位置做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记林区道路</button>
        <button class="btn" type="button" @click="exportRows">导出林区道路清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p v-if="migrationNotice" class="notice-bar">
      <span>{{ migrationNotice }}</span>
      <button class="link" type="button" @click="resumeMigration">从断点继续迁移</button>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="showLedger(row)">台账</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无林区道路数据，可先登记林区道路</td>
        </tr>
      </tbody>
    </table>

    <section v-if="ledgerRows.length" class="ledger-panel">
      <h3 class="panel-title">巡检台账 · {{ ledgerTitle }}</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录时间</th>
            <th>动作</th>
            <th>通行状态</th>
            <th>巡检结果</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledgerRows" :key="entry.id">
            <td>{{ formatTime(entry.记录时间) }}</td>
            <td>{{ entry.动作 }}</td>
            <td>{{ entry.通行状态 }}</td>
            <td>{{ entry.巡检结果 || '—' }}</td>
            <td>{{ entry.来源 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条林区道路记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listRoadLedger,
  migrateRoadTraffic,
  moduleMeta,
  roadMigrationStatus,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, RoadLedgerEntry } from '@/data/types'

const meta = moduleMeta('forestroad')
const columns = ["道路编号", "道路名称", "起点位置", "终点位置", "道路等级", "通行宽度", "最近巡检日", "通行状态"]
const actions = ["安排巡检", "登记施工", "封闭道路"]
const statuses = ["正常通行", "需维护", "正在施工", "禁止通行"]
const stats = [{"label": "道路总里程", "value": 0}, {"label": "需维护段数", "value": 0}, {"label": "施工段数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const migrationNotice = ref('')
const ledgerRows = ref<RoadLedgerEntry[]>([])
const ledgerTitle = ref('')
const ledgerRoadId = ref<number | null>(null)
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '林区道路登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function refreshMigration() {
  const state = roadMigrationStatus()
  migrationNotice.value = state.completed
    ? ''
    : `通行规则迁移未完成：共 ${state.total} 条路段，已回填 ${state.migrated} 条，失败 ${state.failures.length} 条，可从断点继续`
}

function resumeMigration() {
  migrateRoadTraffic()
  reload()
}

function showLedger(row: EntryRow) {
  ledgerRoadId.value = Number(row.id)
  ledgerTitle.value = `${row['道路编号'] ?? row.id} ${row['道路名称'] ?? ''}`
  ledgerRows.value = listRoadLedger(Number(row.id))
}

function formatTime(value: string) {
  return value ? value.replace('T', ' ').slice(0, 16) : '—'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshMigration()
    if (ledgerRoadId.value !== null) {
      ledgerRows.value = listRoadLedger(ledgerRoadId.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林区道路列表读取失败'
  }
}

onMounted(reload)
</script>
