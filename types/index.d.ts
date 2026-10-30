/** One window or figure of a source: `5h 82%`, `已用 $0.12`. */
export type DashPart = {
  name: string
  /** Remaining percent (0-100) when the source has one. */
  remaining?: number
  /** Free text when there is no percentage. */
  text?: string
  /** Reset time, epoch milliseconds. */
  resetsAt?: number
  /** Counted quotas (requests, images): used of limit. */
  used?: number
  limit?: number
  /** A figure with no percentage that has still run low (a balance under its threshold). */
  level?: 'warn' | 'low'
}

export type DashItem = {
  id: string
  /** The source's type: picks its default icon. */
  type: string
  label: string
  icon?: string
  color?: string
  parts: DashPart[]
  /** Why the source gave nothing. */
  error?: string
  /** Not set up here (no credentials, no reading yet): hidden from the band when hideUnavailable. */
  unavailable?: boolean
  /** A note such as "本地记录 3h 前". */
  note?: string
  /** Remaining percent below which this source is shown as low. */
  warnPercent: number
}

export type DashSnapshot = { items: DashItem[]; updatedAt: number }

/** The settings pane's pages. */
export type SettingsTab = 'sources' | 'add' | 'display'

declare module 'claude-code' {
  interface PluginState {
    'usage-dash': {
      snapshot: Shaped<DashSnapshot | null>
      isExpanded: boolean
      /** A source on the page of the expanded details shown: the pager turns it. */
      detailsFrom: number
      /** The settings pane's page shown. */
      tab: SettingsTab
      /** Counts saves of the config file, so the pane redraws after one. */
      configRev: number
      /** The source whose 删除 was pressed once and waits for 确认删除. */
      confirmRemove: string | null
    }
  }
}
