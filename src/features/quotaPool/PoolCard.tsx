import { Fact, FactSection } from '@/components/ui/FactPanel';
import { BillingFacts } from '@/components/ui/FactPanel/BillingFacts';
import { billingFacts } from '@/domain/accountBilling';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconCircleHalf,
  IconClock,
  IconHistory,
  IconInfo,
  IconTimer,
  IconX,
} from '@/components/ui/icons';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { metricField, type ChartMode } from './chartGeometry';
import { DAY_MS } from '@/utils/time/durations';
import { useNow } from '@/hooks/useNow';
import type { AccountResets } from '@/domain/quotaPool/types';
import { laneOf, poolWindowId } from '@/domain/quotaWindows/lanes';
import { profileWindowId } from '@/domain/quotaWindows/normalized';
import { isBuiltInPoolProvider } from '@/domain/quotaPool/providers';
import { heldResetKinds, wasSpent, type ResetKindCount } from './resetAccounts';
import { PoolAccountResets, ResetKindCounts } from './PoolAccountResets';
import { PoolChart } from './PoolChart';
import { PoolGraph } from './PoolGraph';
import { PoolGraphToggle } from './PoolGraphToggle';
import { PoolProviderMark } from './PoolProviderMark';
import { poolProviderLabel, poolProviderStyle, quotaWindowLabel } from './providerPresentation';
import { poolChip, type PoolChipIcon } from './model/poolChip';
import { sortAccounts, type AccountSort } from './model/accountOrder';
import { formatPoolDate, formatPoolNumber, formatPoolPercent, isLowQuota } from './presentation';
import styles from './QuotaPoolPage.module.scss';

/** Rosters longer than this get a search box and a sort, so one account can be found. */
const ROSTER_CONTROLS_MIN = 8;
/** Rows shown before "Show all", so a long roster doesn't bury the next pool. */
const ROSTER_PAGE = 25;
/** This page says only "from start date" beside each estimate; one caveat per Accounts section carries the rest. */
const ESTIMATE_BASIS_OVERRIDES = { billing_estimate_basis: 'billing_estimate_from_start' };
const CHIP_ICONS: Record<PoolChipIcon, typeof IconCheck> = {
  check: IconCheck,
  partial: IconCircleHalf,
  stale: IconClock,
  saved: IconHistory,
  collecting: IconTimer,
  info: IconInfo,
};

/** What is held, by kind, in the language's own word order: "1 weekly · 2 Fable held" (G11). */
function HeldKinds({ kinds }: { kinds: ResetKindCount[] }) {
  const { t } = useTranslation();
  const [before, after] = t('quota_pool.reset_kinds_held', { kinds: '\u0000' }).split('\u0000');
  return (
    <>
      {before}
      <ResetKindCounts kinds={kinds} />
      {after}
    </>
  );
}

/**
 * The stacked rows' reset chip, in the wide cell's order: "Manual resets · 3 usable" over what is held
 * ("1 weekly · 2 Fable held", or "2 held" when the kinds are unknown), so the held line always says
 * "held" (G11). It always breaks after the usable count, so no row strands a lone kind or a dangling
 * separator (G10).
 */
function ResetChip({ resets, now }: { resets: AccountResets; now: number }) {
  const { t } = useTranslation();
  const kinds = heldResetKinds(resets, now);
  return (
    <>
      <span className={styles.resetChipPart}>
        {t('quota_pool.resets')} · {t('quota_pool.reset_usable_part', { usable: resets.usable })}
      </span>
      <span className={styles.resetChipPart}>
        {kinds ? (
          <HeldKinds kinds={kinds} />
        ) : (
          t('quota_pool.reset_held_part', { count: resets.available })
        )}
      </span>
    </>
  );
}

/**
 * The wide table's Manual resets cell: what can be used now over what is held (by kind when known), in
 * every row, so rows read alike and nothing runs into the next column. An account whose provider sent
 * no reset data shows a quiet dash, explained once in the column header. Phones keep the chip.
 */
function ResetCell({ resets, spent, now }: { resets: AccountResets | null; spent: boolean; now: number }) {
  const { t } = useTranslation();
  if (!resets)
    return (
      <>
        <span data-quiet="" aria-hidden="true">
          –
        </span>
        <span className={styles.visuallyHidden}>{t('quota_pool.not_reported')}</span>
      </>
    );
  if (spent) return <span data-quiet="">{t('quota_pool.reset_requested')}</span>;
  if (resets.available === 0) return <span data-quiet="">{t('quota_pool.reset_none')}</span>;
  return (
    <>
      <span data-usable={resets.usable > 0 || undefined}>
        {t('quota_pool.reset_usable_part', { usable: resets.usable })}
      </span>
      <HeldLine kinds={heldResetKinds(resets, now)} available={resets.available} />
    </>
  );
}

/**
 * The cell's held line: the kinds when they fit its one line in the font the browser really uses,
 * else the count, so a row never wraps (the opened row lists each kind). A hidden copy of the kinds
 * measures the fit, again whenever the cell resizes (it has no width while rows are stacked).
 */
function HeldLine({ kinds, available }: { kinds: ResetKindCount[] | null; available: number }) {
  const { t, i18n } = useTranslation();
  const lineRef = useRef<HTMLElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  const kindsKey = kinds?.map(({ kind, count }) => `${count} ${kind}`).join();
  useLayoutEffect(() => {
    const cell = lineRef.current?.parentElement;
    const probe = probeRef.current;
    if (!cell || !probe) return;
    // Fractional widths: a 120.1px line rounds to 120 and would wrap in a 120px cell.
    const check = () => {
      const room = cell.getBoundingClientRect().width;
      if (room > 0) setFits(probe.getBoundingClientRect().width <= room);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(cell);
    void document.fonts?.ready.then(check);
    return () => observer.disconnect();
  }, [kindsKey, i18n.language]);
  return (
    <>
      <small ref={lineRef}>
        {kinds && fits ? (
          <HeldKinds kinds={kinds} />
        ) : (
          t('quota_pool.reset_held_part', { count: available })
        )}
      </small>
      {kinds && (
        <span ref={probeRef} className={styles.heldProbe} aria-hidden="true">
          <HeldKinds kinds={kinds} />
        </span>
      )}
    </>
  );
}

/** One label/value pair of the Accounts summary; the pair wraps as a unit, never inside. */
function SummaryFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={styles.summaryFact}>
      <span className={styles.summaryLabel}>{label}</span>{' '}
      <b className={styles.summaryValue}>{children}</b>
    </span>
  );
}

/** At 900px and below an opened row reads: limits, Manual resets, Usage, Billing. */
const STACKED_FACTS = '(max-width: 900px)';
/** Phones put a card's state note after its facts, ahead of the action pills (G11). */
const PHONE = '(max-width: 640px)';
/** Whether a media query matches, following changes. Rendered on the server it never does: the wide layout. */
function useMedia(query: string) {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

export function PoolCard({
  pool,
  dashboard,
  mode,
  reveal,
  savedData = false,
  move,
  onRefresh = () => {},
}: {
  onRefresh?: (accountId?: string) => void;
  pool: QuotaPool;
  dashboard: PoolDashboard;
  mode: ChartMode;
  reveal: boolean;
  savedData?: boolean;
  /** Reorder controls; a missing direction (first or last card) is not drawn. */
  move?: { up?: () => void; down?: () => void };
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const stackedFacts = useMedia(STACKED_FACTS);
  const phone = useMedia(PHONE);
  const [minimized, setMinimized] = useState(false);
  const [rosterQuery, setRosterQuery] = useState('');
  const [rosterSort, setRosterSort] = useState<AccountSort>('name');
  const [lowOnly, setLowOnly] = useState(false);
  const [affectedOnly, setAffectedOnly] = useState(false);
  // Bumped by the notice's action; the effect then brings the first affected row into focus.
  const [affectedFocus, setAffectedFocus] = useState(0);
  const accountsRef = useRef<HTMLElement>(null);
  const accountsHeadingRef = useRef<HTMLHeadingElement>(null);
  const [showAll, setShowAll] = useState(false);
  // Opening a row reveals reset details.
  const [openAccounts, setOpenAccounts] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = pool.accounts.length > 0 && pool.accounts.every((a) => openAccounts.has(a.id));
  const setAccountOpen = (accountId: string, open: boolean) =>
    setOpenAccounts((current) => {
      if (current.has(accountId) === open) return current;
      const next = new Set(current);
      if (open) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const percent = (value: number) => formatPoolPercent(value, i18n.language);
  const date = (value: number | null) => formatPoolDate(value, i18n.language);
  // The visible word is the accessible text; the red icon and bar carry the colour. Meaning never
  // rests on colour alone, and the percentage keeps the normal value colour.
  const lowMark = (
    <span className={styles.lowMark}>
      <span className={styles.limitWarning} aria-hidden="true">
        <IconAlertTriangle size={14} aria-hidden="true" />
      </span>
      <span className={styles.lowWord}>{t('quota_pool.limit_low')}</span>
    </span>
  );
  const forecastDate = (value: number | null, available = pool.forecastState === 'ready') =>
    value === null ? (
      available ? (
        // Not reached before the server's forecast horizon (server/quota/domain.ts projects to
        // the later of the range end and 14 days out), whatever the chart shows.
        t('quota_pool.after_range', {
          date: formatPoolDate(
            Math.max(dashboard.toMs, dashboard.nowMs + 14 * DAY_MS),
            i18n.language,
            true
          ),
        })
      ) : (
        <>
          <span aria-hidden="true">—</span>
          <span className={styles.srOnly}>{t('quota_pool.forecast_unavailable')}</span>
        </>
      )
    ) : (
      date(value)
    );
  const windowLabel = t(`quota_pool.${dashboard.window === 'weekly' ? 'weekly' : 'five_hour'}`);
  const profile = dashboard.poolProfiles?.find(
    (entry) => entry.instanceId === pool.instanceId && entry.provider === pool.provider
  );
  const unmapped = profile !== undefined && profileWindowId(profile, dashboard.window) === null;
  const noLimitLabel = unmapped
    ? `${windowLabel} · ${t('provider_catalog.pool_profile_none')}`
    : t('quota_pool.no_window_limit', { window: windowLabel });
  const balanceLabel = t('quota_pool.window_remaining', { window: windowLabel });
  const showRosterControls = pool.accounts.length > ROSTER_CONTROLS_MIN;
  const accountName = (account: (typeof pool.accounts)[number]) =>
    reveal && account.email ? account.email : (account.identifier ?? account.label);
  const missingAccounts = pool.accounts.filter(
    (account) => account.status === 'error' || account.status === 'missing-window'
  );
  const staleAccounts = pool.accounts.filter((account) => account.status === 'stale');
  // The accounts holding the total back. The notice counts them and its action shows them in
  // the list, instead of naming masked addresses that wrap badly.
  const affectedAccounts =
    pool.forecastState === 'partial'
      ? missingAccounts
      : pool.forecastState === 'stale'
        ? staleAccounts
        : [];
  const affectedIds = new Set(affectedAccounts.map((account) => account.id));
  // A total with estimated accounts is still shown; the note says so instead of "withheld".
  const estimated = pool.remainingPoints !== null ? (pool.estimatedCount ?? 0) : 0;
  const stateNote = unmapped
    ? noLimitLabel
    : estimated > 0
      ? t('quota_pool.estimated_count', { count: estimated, total: pool.accountCount })
      : pool.forecastState === 'partial' && missingAccounts.length
        ? t('quota_pool.unavailable_count', {
            count: missingAccounts.length,
            total: pool.accountCount,
          })
        : pool.forecastState === 'stale' && staleAccounts.length
          ? t('quota_pool.stale_count', { count: staleAccounts.length, total: pool.accountCount })
          : t(`quota_pool.state_note.${pool.forecastState}`, { window: windowLabel });
  const showAffected = () => {
    setAffectedOnly(true);
    setLowOnly(false);
    setRosterQuery('');
    setShowAll(false);
    setAffectedFocus((value) => value + 1);
  };
  useEffect(() => {
    if (!affectedFocus) return;
    accountsRef.current?.scrollIntoView({ block: 'start' });
    accountsRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  }, [affectedFocus]);
  // The header's "N accounts" jumps past the chart to the roster. Focus goes to the Accounts heading, not
  // the search box, so a phone's keyboard stays closed.
  const jumpToAccounts = () => {
    accountsRef.current?.scrollIntoView({ block: 'start' });
    accountsHeadingRef.current?.focus({ preventScroll: true });
  };
  const forecastWithheld = pool.forecastState !== 'ready' && pool.forecastState !== 'no-limit';
  // A withheld forecast with no burn rate has nothing measured to add beside the headline.
  const showNow = mode !== 'remaining' || !(forecastWithheld && pool.burnPointsPerHour === null);
  // Claude names its weekly windows "7-day"; the page calls that window Weekly everywhere.
  // The columns show remaining percentages, so the headings say "remaining", not "limit".
  const limitLabel = (limit: (typeof pool.accounts)[number]['windows'][number]) => {
    if (!isBuiltInPoolProvider(pool.provider)) return quotaWindowLabel(t, limit);
    const lane = laneOf(pool.provider, limit.id);
    if (lane === 'five-hour') return t('quota_pool.five_hour_remaining');
    if (lane === 'weekly') return t('quota_pool.weekly_remaining');
    if (limit.id === 'seven-day-opus') return t('quota_pool.weekly_opus_remaining');
    return quotaWindowLabel(t, limit);
  };
  const query = rosterQuery.trim().toLowerCase();
  const matchingAccounts = pool.accounts.filter(
    (account) => !query || accountName(account).toLowerCase().includes(query)
  );
  // Counted within the search, so the chip's number is what the filter will show.
  const lowAccountCount = matchingAccounts.filter((account) =>
    account.windows.some((limit) => isLowQuota(limit.remainingPercent))
  ).length;
  const visibleAccounts = sortAccounts(
    matchingAccounts.filter(
      (account) =>
        (!lowOnly || account.windows.some((limit) => isLowQuota(limit.remainingPercent))) &&
        (!affectedOnly || affectedIds.has(account.id))
    ),
    rosterSort,
    accountName,
    i18n.language
  );
  // One column per limit the roster reports, so every account's bars line up under one heading.
  const limitColumns = pool.accounts.reduce<
    Array<(typeof pool.accounts)[number]['windows'][number]>
  >((columns, account) => {
    account.windows.forEach((limit) => {
      if (!columns.some((column) => column.id === limit.id)) columns.push(limit);
    });
    return columns;
  }, []);
  // The pool balance is the sample of one limit (server/quota/collector.ts): the 5-hour
  // limit, or the provider's weekly one. Mark that column instead of repeating it.
  const countedLimitId = isBuiltInPoolProvider(pool.provider)
    ? poolWindowId(pool.provider, dashboard.window)
    : profile && profileWindowId(profile, dashboard.window);
  // The counted limit leads, as it does in the stacked rows, so every width reads the limits in one
  // order (G11); the rest keep the provider's order.
  limitColumns.sort((a, b) => Number(b.id === countedLimitId) - Number(a.id === countedLimitId));
  const balanceHasColumn = limitColumns.some((column) => column.id === countedLimitId);
  // A wide column that shows a Low mark on any row reserves a status slot after its bar, so the
  // values and bars of the whole column start and end at one x. Unavailable cells span their own
  // row's value slot without shifting healthy columns or opening a gap in healthy rows.
  const columnStatus = new Map<string, { low: boolean }>();
  pool.accounts.forEach((account) =>
    account.windows.forEach((limit) => {
      // A Low mark or an "Unavailable" word needs the column's status slot; without it the word
      // runs into the next column (G9).
      if (isLowQuota(limit.remainingPercent)) columnStatus.set(limit.id, { low: true });
      else if (limit.remainingPercent === null && !columnStatus.has(limit.id))
        columnStatus.set(limit.id, { low: false });
    })
  );
  const resetSection = (account: (typeof pool.accounts)[number]) =>
    openAccounts.has(account.id) &&
    (pool.provider === 'claude' || pool.provider === 'codex') && (
      <PoolAccountResets
        key="resets"
        account={account}
        name={accountName(account)}
        provider={pool.provider}
        instanceId={pool.instanceId}
        onRefresh={onRefresh}
      />
    );
  // At 900px and below a row reads as blocks: the active window leads the limit list instead of
  // being the bold figure in the header. An account that reports no windows (or a pool with no column
  // for the active one) keeps the figure.
  const phoneBlocks = (account: (typeof pool.accounts)[number]) =>
    balanceHasColumn && account.windows.length > 0;
  const missingLimit = (
    account: (typeof pool.accounts)[number],
    column: (typeof limitColumns)[number]
  ) => (
    <li
      key={`missing-${column.id}`}
      data-limit-id={column.id}
      data-missing="true"
      data-counted={column.id === countedLimitId || undefined}
      data-low="false"
      style={
        {
          '--col': limitColumns.findIndex((other) => other.id === column.id) + 1,
        } as CSSProperties
      }
    >
      <span>{limitLabel(column)}</span>
      {/* The reason fills the cell, so the column still says why it is empty. */}
      <em>
        {account.noFiveHourLimit && column.id === 'five-hour'
          ? t('quota_pool.no_window_limit', {
              window: t('quota_pool.five_hour'),
            })
          : t('quota_pool.not_reported')}
      </em>
      {/* Wide tables: an empty value slot the width of the column's others (Low ghost and value), so
          the reason starts where the column's bars start (G10). */}
      <strong className={styles.missingSlot} aria-hidden="true">
        {columnStatus.get(column.id)?.low && (
          <span className={styles.statusGhost} data-word={t('quota_pool.limit_low')} />
        )}
        <span className={styles.limitValue} />
      </strong>
    </li>
  );
  // Show the renewal estimate caveat only when at least one row with an estimated renewal is open,
  // so collapsed lists never show a loose caveat about dates that are not on screen.
  const hasOpenEstimatedRenewal = pool.accounts.some(
    (account) =>
      openAccounts.has(account.id) &&
      billingFacts(account.billing ?? null, dashboard.nowMs).some(
        (fact) => fact.state === 'estimated' && fact.labelKey === 'billing_renews'
      )
  );
  const pageAccounts = showAll ? visibleAccounts : visibleAccounts.slice(0, ROSTER_PAGE);
  const noLimitCount =
    dashboard.window === 'five-hour'
      ? pool.accounts.filter((account) => account.noFiveHourLimit).length
      : 0;
  const now = useNow();
  const resetTotals = pool.accounts.reduce(
    (sum, account) =>
      account.resets && wasSpent(account.id, account.resets.observedAtMs)
        ? sum
        : {
            available: sum.available + (account.resets?.available ?? 0),
            usable: sum.usable + (account.resets?.usable ?? 0),
          },
    { available: 0, usable: 0 }
  );
  const coverageMissing =
    pool.loadedCount !== pool.accountCount || pool.eligibleCount !== pool.accountCount;
  // Accounts without a 5-hour limit are not missing: with all the rest reporting there is no coverage fact.
  const showCoverage =
    coverageMissing &&
    !(staleAccounts.length === 0 && noLimitCount > 0 && pool.loadedCount >= pool.eligibleCount);
  const chip = poolChip(pool.forecastState, savedData);
  const ChipIcon = CHIP_ICONS[chip.icon];
  const headlineContext = (
    <div className={styles.headlineContext}>
      <p className={styles.metricLabel}>
        {mode !== 'remaining'
          ? t('quota_pool.recorded_rate', {
              rate: t(`quota_pool.${mode}`),
              hours: dashboard.lookbackHours,
            })
          : balanceLabel}
      </p>
    </div>
  );
  const providerLabel = poolProviderLabel(t, pool.provider, pool.displayName);
  const appearance = poolProviderStyle(pool.provider);
  const slotCount = limitColumns.filter((column) => columnStatus.has(column.id)).length;
  // Why the forecast or total is limited, across the card under its summary. On phones it sits in the
  // header after the facts, so the action pills that follow it stay right above the chart (G11).
  const stateBanner = pool.forecastState !== 'ready' && (
    <p className={styles.stateNote} role="status" data-state={pool.forecastState}>
      {/* The page's one "Refresh now" sits in the combined card's notice above. */}
      <span>{stateNote}</span>
      {affectedAccounts.length > 0 && (
        // Once the list is filtered, the same button puts every account back.
        <button
          type="button"
          className={styles.noteAction}
          onClick={affectedOnly ? () => setAffectedOnly(false) : showAffected}
        >
          {t(affectedOnly ? 'quota_pool.show_all_accounts' : 'quota_pool.show_affected')}
        </button>
      )}
    </p>
  );
  return (
    <article
      className={`${styles.pool} ${appearance.className ?? ''}`}
      style={appearance.style}
      aria-labelledby={`${id}-title`}
      data-forecast-state={pool.forecastState}
      data-chart-mode={mode}
      data-minimized={minimized}
      data-saved={savedData}
    >
      <div className={styles.poolHeader}>
        <div className={styles.poolIdentity}>
          <div className={styles.poolTitle}>
            <PoolProviderMark provider={pool.provider} />
            <h2 id={`${id}-title`}>
              {providerLabel}
              {pool.sourceLabel && <small> · {pool.sourceLabel}</small>}
            </h2>
            <div className={styles.poolMeta}>
              <button
                type="button"
                className={styles.accountsJump}
                aria-describedby={`${id}-accounts-jump`}
                onClick={jumpToAccounts}
              >
                {t('quota_pool.account_count', { count: pool.accountCount })}
              </button>
              <span id={`${id}-accounts-jump`} className={styles.srOnly}>
                {t('quota_pool.accounts_jump')}
              </span>
              <span
                className={styles.badge}
                data-state={chip.state}
                data-chip-icon={chip.icon}
                data-tone={chip.tone}
              >
                <ChipIcon size={13} aria-hidden="true" />
                {savedData
                  ? t('quota_pool.saved_forecast')
                  : t('quota_pool.forecast_status', {
                      state: t(`quota_pool.state.${pool.forecastState}`).toLocaleLowerCase(
                        i18n.language
                      ),
                    })}
              </span>
            </div>
          </div>
          <span className={styles.reorder}>
            {pool.forecastState !== 'no-limit' && (
              <PoolGraphToggle
                minimized={minimized}
                onToggle={() => setMinimized((value) => !value)}
                label={`${providerLabel}${pool.sourceLabel ? ` · ${pool.sourceLabel}` : ''}`}
                controls={`${id}-plot`}
              />
            )}
            {/* A move that can't happen (first or last card) isn't drawn. */}
            {move?.up && (
              <button
                type="button"
                onClick={move.up}
                aria-label={t('quota_pool.move_up', { pool: providerLabel })}
                title={t('quota_pool.move_up', { pool: providerLabel })}
              >
                <IconArrowUp size={16} aria-hidden="true" />
                {t('quota_pool.move_up_short')}
              </button>
            )}
            {move?.down && (
              <button
                type="button"
                onClick={move.down}
                aria-label={t('quota_pool.move_down', { pool: providerLabel })}
                title={t('quota_pool.move_down', { pool: providerLabel })}
              >
                <IconArrowDown size={16} aria-hidden="true" />
                {t('quota_pool.move_down_short')}
              </button>
            )}
          </span>
        </div>
        {/* Every view has the same two groups: "Now" holds the one measured fact the headline
            doesn't show (the burn rate, or in rate views the balance), "Forecast" the projections. */}
        <div className={styles.statsBlock} data-split={showNow || undefined}>
          {/* G12: one card holds the remaining number with Now docked as its footer; Forecast is the
              second card, its facts as small cells (Neon's option 3, the user's pick). */}
          <div className={styles.leadCard}>
            <div
              className={styles.headline}
              data-unavailable={pool[metricField[mode]] === null}
              data-rate={mode !== 'remaining'}
              data-no-limit={pool.forecastState === 'no-limit'}
            >
              {/* Unified label-above-value hero across Remaining and Rate views: metric label on top,
                  figure + baseline unit/capacity below. */}
              {pool.forecastState !== 'no-limit' && headlineContext}
              <strong>
                {pool.forecastState === 'no-limit' ? (
                  <span className={styles.unavailableValue}>{noLimitLabel}</span>
                ) : pool[metricField[mode]] === null ? (
                  // A muted word in the number slot, so a withheld total never passes for a value.
                  <span className={styles.unavailableValue}>{t('quota_pool.value_withheld')}</span>
                ) : (
                  <>
                    {number(pool[metricField[mode]])}
                    {mode !== 'remaining' ? (
                      <small> {t('quota_pool.points_hour')}</small>
                    ) : (
                      <small>
                        {' '}
                        {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
                      </small>
                    )}
                  </>
                )}
              </strong>
            </div>
          {showNow && (
            <div className={styles.statsGroup} data-group="now">
              <p className={styles.statsHeading}>{t('quota_pool.now_group')}</p>
              <dl className={styles.stats}>
                {mode === 'remaining' ? (
                  <div>
                    <dt>{t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}</dt>
                    <dd>
                      {number(pool.burnPointsPerHour)}
                      {pool.burnPointsPerHour !== null && <small> {t('quota_pool.points_hour')}</small>}
                    </dd>
                  </div>
                ) : (
                  <div>
                    <dt>{t('quota_pool.account_remaining', { window: windowLabel })}</dt>
                    {/* The number takes the value style; "of 300 points" the headline unit's muted style. */}
                    <dd>
                      {pool.forecastState === 'no-limit' ? (
                        noLimitLabel
                      ) : (
                        <>
                          {number(pool.remainingPoints)}{' '}
                          <small>
                            {t('quota_pool.of_capacity', { capacity: number(pool.capacityPoints) })}
                          </small>
                        </>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
          </div>
          <div className={styles.statsGroup} data-group="forecast">
            {/* The 5-hour view names its window once, over every forecast fact (G11); weekly is the default. */}
            <p className={styles.statsHeading}>
              {t(`quota_pool.remaining_forecast${dashboard.window === 'five-hour' ? '_five_hour' : ''}`)}
            </p>
            <dl className={styles.stats}>
              {/* A withheld forecast is explained by the notice; its empty facts aren't repeated. */}
              {!(forecastWithheld && pool.poolEmptyAtMs === null) && (
                <div>
                  <dt>{t('quota_pool.pool_empty')}</dt>
                  <dd>{forecastDate(pool.poolEmptyAtMs)}</dd>
                </div>
              )}
              {!(forecastWithheld && pool.firstEmptyAtMs === null) && (
                <div>
                  <dt>{t('quota_pool.first_empty')}</dt>
                  <dd>{forecastDate(pool.firstEmptyAtMs)}</dd>
                </div>
              )}
              <div>
                <dt>{t('quota_pool.next_reset')}</dt>
                <dd>{date(pool.nextResetAtMs)}</dd>
                {pool.nextResetGainPoints !== null && (
                  <small>
                    +{number(pool.nextResetGainPoints)} {t('quota_pool.points')}
                  </small>
                )}
              </div>
            </dl>
          </div>
        </div>
        {phone && stateBanner}
      </div>
      {!phone && stateBanner}
      {/* No limit in this window means nothing to chart; the note above already says so. */}
      {pool.forecastState !== 'no-limit' && (
        <PoolGraph title={t('quota_pool.history_forecast')} id={`${id}-plot`} minimized={minimized}>
          <PoolChart
            key={`${mode}-${dashboard.fromMs}`}
            pool={pool}
            dashboard={dashboard}
            mode={mode}
            savedData={savedData}
            minimized={minimized}
          />
        </PoolGraph>
      )}
      <section
        ref={accountsRef}
        className={styles.accounts}
        data-slots={slotCount}
        aria-labelledby={`${id}-accounts`}
      >
        <h3 id={`${id}-accounts`} ref={accountsHeadingRef} tabIndex={-1}>
          <span className={styles.accountsHeading}>
            <span className={styles.accountsTitleStack}>
              <b className={styles.accountHeadingLabel}>{t('quota_pool.accounts')}</b>
              {/* Phones have no column heading, so attach the counted-limit note directly to the Accounts heading. */}
              {visibleAccounts.length > 0 && (
                <span className={styles.phoneCountsNote}>
                  {t('quota_pool.counts_toward_total_phone', { window: windowLabel })}
                </span>
              )}
            </span>
            {/* The pool's resets as one fact in every card that holds any ("8 usable of 8 held"; the rows
                give the kinds), so cards never differ in whether it shows (G11). Coverage facts always
                show when partial. */}
            {(resetTotals.available > 0 || showCoverage) && (
              <span className={styles.accountSummary}>
                {resetTotals.available > 0 && (
                  <SummaryFact label={t('quota_pool.resets')}>
                    {t('quota_pool.reset_summary_value', {
                      usable: resetTotals.usable,
                      held: resetTotals.available,
                    })}
                  </SummaryFact>
                )}
                {/* The card header already counts the accounts; say coverage only when some are missing.
                    In the 5-hour view an account without that limit is excluded, not missing. */}
                {coverageMissing && staleAccounts.length > 0 ? (
                  <>
                    <SummaryFact label={t('quota_pool.summary_current')}>
                      {pool.loadedCount}
                    </SummaryFact>
                    <SummaryFact label={t('quota_pool.summary_stale')}>
                      {staleAccounts.length}
                    </SummaryFact>
                  </>
                ) : coverageMissing && noLimitCount > 0 ? (
                  // Each account without a 5-hour limit says so in its row, so only a missing reading
                  // among the rest is a pool fact (G11).
                  pool.loadedCount < pool.eligibleCount && (
                    <SummaryFact label={t('quota_pool.summary_reporting')}>
                      {t('quota_pool.summary_x_of_y', {
                        x: pool.loadedCount,
                        y: pool.eligibleCount,
                      })}
                    </SummaryFact>
                  )
                ) : (
                  coverageMissing && (
                    <SummaryFact label={t('quota_pool.summary_reporting')}>
                      {t('quota_pool.summary_x_of_y', {
                        x: pool.loadedCount,
                        y: pool.eligibleCount,
                      })}
                    </SummaryFact>
                  )
                )}
              </span>
            )}
          </span>
          {pool.accounts.length > 0 && (
            <button
              type="button"
              className={styles.expandAccounts}
              aria-expanded={allOpen}
              onClick={() =>
                setOpenAccounts(allOpen ? new Set() : new Set(pool.accounts.map((a) => a.id)))
              }
            >
              {t(allOpen ? 'quota_pool.collapse_accounts' : 'quota_pool.expand_accounts')}
            </button>
          )}
        </h3>
        {(showRosterControls || affectedOnly) && (
          <div className={styles.rosterTools}>
            {showRosterControls && (
              <>
                {/* The label stays in view whatever is typed; it is the field's accessible name, so a
                    placeholder would only repeat it. */}
                <label className={styles.rosterSearch}>
                  <span className={styles.rosterSearchLabel}>{t('quota_pool.account_search')}</span>
                  <input
                    type="search"
                    value={rosterQuery}
                    onChange={(event) => setRosterQuery(event.target.value)}
                  />
                </label>
                {/* Like the search field, the pill carries a visible prefix; the select inside keeps the
                    accessible name "Sort accounts", which starts with it. */}
                <label className={styles.rosterSort}>
                  <span className={styles.rosterSearchLabel}>
                    {t('quota_pool.account_sort_label')}
                  </span>
                  <select
                    value={rosterSort}
                    onChange={(event) => setRosterSort(event.target.value as AccountSort)}
                    aria-label={t('quota_pool.account_sort')}
                  >
                    <option value="name">{t('quota_pool.sort_name')}</option>
                    <option value="lowest">{t('quota_pool.sort_lowest')}</option>
                  </select>
                </label>
              </>
            )}
            {(affectedOnly || (showRosterControls && affectedAccounts.length > 0)) && (
              <button
                type="button"
                className={styles.rosterLow}
                aria-pressed={affectedOnly}
                onClick={() => {
                  setAffectedOnly((value) => !value);
                  setLowOnly(false);
                }}
              >
                {affectedOnly ? (
                  <IconCheck size={14} aria-hidden="true" />
                ) : (
                  <IconAlertTriangle size={14} aria-hidden="true" />
                )}
                {t('quota_pool.accounts_affected', { count: affectedAccounts.length })}
                {affectedOnly && (
                  <IconX size={14} aria-hidden="true" className={styles.rosterClear} />
                )}
              </button>
            )}
            {showRosterControls && (lowAccountCount > 0 || lowOnly) && (
              <button
                type="button"
                className={styles.rosterLow}
                aria-pressed={lowOnly}
                onClick={() => {
                  setLowOnly((value) => !value);
                  setAffectedOnly(false);
                }}
              >
                {lowOnly ? (
                  <IconCheck size={14} aria-hidden="true" />
                ) : (
                  <IconAlertTriangle size={14} aria-hidden="true" />
                )}
                {/* Off says what pressing does and what the count counts ("Show 40 …"); on says it is
                    filtering, and the × says a second press clears it (the blind A/B kept these words). */}
                {t(lowOnly ? 'quota_pool.accounts_low_on' : 'quota_pool.accounts_low', {
                  count: lowAccountCount,
                })}
                {lowOnly && <IconX size={14} aria-hidden="true" className={styles.rosterClear} />}
              </button>
            )}
            {/* Always the last item: D of T shown; while filtering, D of F matches shown · T total.
                When every match is on screen (D = F) it says "F of T match" once; no match says so. */}
            <span className={styles.rosterCount} role="status">
              {!(query || lowOnly || affectedOnly)
                ? t('quota_pool.accounts_shown', {
                    shown: pageAccounts.length,
                    total: pool.accounts.length,
                  })
                : visibleAccounts.length === 0
                  ? t('quota_pool.accounts_no_match', { count: 0, total: pool.accounts.length })
                  : pageAccounts.length < visibleAccounts.length
                    ? t('quota_pool.accounts_matches_shown', {
                        shown: pageAccounts.length,
                        count: visibleAccounts.length,
                        total: pool.accounts.length,
                      })
                    : t('quota_pool.accounts_match_only', {
                        count: visibleAccounts.length,
                        total: pool.accounts.length,
                      })}
            </span>
          </div>
        )}
        <div
          className={styles.accountGrid}
          data-large={showRosterControls}
          data-balance-column={!balanceHasColumn}
          data-slots={slotCount}
          style={
            ({
              '--limit-cols': Math.max(1, limitColumns.length),
              // A column with a Low status slot is that much wider than one without, so every bar
              // inside a provider card shares one equal bar width and fills the full table width.
              '--slotted-cols': limitColumns.filter((column) => columnStatus.has(column.id)).length,
              '--limit-tracks': limitColumns
                .map((column) =>
                  columnStatus.has(column.id) ? 'var(--limit-slotted)' : 'var(--limit-plain)'
                )
                .join(' '),
            }) as CSSProperties
          }
        >
          {visibleAccounts.length > 0 && (
            <div className={styles.accountHead} aria-hidden="true">
              <span />
              <span>{t('quota_pool.account_column')}</span>
              <span className={styles.resetHead}>
                {t('quota_pool.resets')}
                {pageAccounts.some((account) => !account.resets) && (
                  <small>{t('quota_pool.reset_dash_key')}</small>
                )}
              </span>
              {limitColumns.map((limit) =>
                columnStatus.get(limit.id)?.low ? (
                  // A column with a Low mark indents its header by the same hidden slot its rows
                  // reserve, so the header starts over its values, not over the empty slot (G10).
                  <span
                    key={limit.id}
                    data-counted={limit.id === countedLimitId || undefined}
                    data-slotted=""
                  >
                    <i className={styles.statusGhost} data-word={t('quota_pool.limit_low')} />
                    <b className={styles.headLabel}>
                      {limitLabel(limit)}
                      {limit.id === countedLimitId && (
                        <small>{t('quota_pool.counts_toward_total')}</small>
                      )}
                    </b>
                  </span>
                ) : (
                  <span key={limit.id} data-counted={limit.id === countedLimitId || undefined}>
                    {limitLabel(limit)}
                    {limit.id === countedLimitId && (
                      <small>{t('quota_pool.counts_toward_total')}</small>
                    )}
                  </span>
                )
              )}
              {!balanceHasColumn && (
                <span>{t('quota_pool.account_remaining', { window: windowLabel })}</span>
              )}
            </div>
          )}
          {pool.accounts.length === 0 ? (
            <p className={styles.stateNote}>{t('quota_pool.state_note.no-accounts')}</p>
          ) : visibleAccounts.length === 0 ? (
            <p className={styles.stateNote} role="status">
              {t('quota_pool.no_account_matches')}
            </p>
          ) : (
            pageAccounts.map((account) => (
              <details
                key={account.id}
                className={styles.account}
                data-status={account.status}
                data-phone-blocks={phoneBlocks(account) || undefined}
                data-unavailable-cell={
                  account.windows.some((limit) => limit.remainingPercent === null) || undefined
                }
                open={openAccounts.has(account.id)}
                onToggle={(event) => setAccountOpen(account.id, event.currentTarget.open)}
              >
                <summary aria-expanded={openAccounts.has(account.id)}>
                  <IconChevronDown
                    className={styles.accountDisclosure}
                    size={20}
                    aria-hidden="true"
                  />
                  <span className={styles.accountName}>
                    <span className={styles.accountLabel}>
                      <span className={styles.accountText}>{accountName(account)}</span>
                      {/* One compact badge beside the name, so the Plan cell holds only the plan. */}
                      {account.resets &&
                        account.resets.available > 0 &&
                        !wasSpent(account.id, account.resets.observedAtMs) && (
                          <span
                            className={styles.accountResetMarker}
                            data-usable={account.resets.usable > 0 || undefined}
                          >
                            <ResetChip resets={account.resets} now={now} />
                          </span>
                        )}
                    </span>
                    <small className={styles.accountPlan}>
                      {account.plan.known
                        ? t('quota_pool.account_plan', {
                            plan: account.plan.label ?? t('quota_pool.plan_column'),
                            points: number(account.plan.capacityPoints),
                          })
                        : t('quota_pool.account_plan_unknown', {
                            points: number(account.plan.capacityPoints),
                          })}
                    </small>
                  </span>
                  <span className={styles.resetCell}>
                    {/* The column header is hidden from screen readers, so the cell names itself. */}
                    <span className={styles.visuallyHidden}>{t('quota_pool.resets')} </span>
                    <ResetCell
                      resets={account.resets}
                      spent={
                        !!account.resets && wasSpent(account.id, account.resets.observedAtMs)
                      }
                      now={now}
                    />
                  </span>
                  <span className={styles.accountStatus}>
                    {account.status === 'stale' ? (
                      <>
                        <span className={styles.staleWord}>
                          <IconClock className={styles.staleIcon} size={14} aria-hidden="true" />
                          {t('quota_pool.account_status.stale')}
                        </span>{' '}
                        {/* "Last reading …" wraps as one unit, never between its words. */}
                        <span className={styles.staleSince}>
                          <span className={styles.staleDot}>· </span>
                          {t('quota_pool.observed')}{' '}
                          <span className={styles.nowrap}>{date(account.observedAtMs)}</span>
                        </span>
                      </>
                    ) : account.status === 'no-limit' ? (
                      noLimitLabel
                    ) : account.status === 'missing-window' || account.status === 'error' ? (
                      t('quota_pool.window_unavailable', { window: windowLabel })
                    ) : (
                      t(`quota_pool.account_status.${account.status}`)
                    )}
                  </span>
                  <strong data-low={isLowQuota(account.remainingPercent) || undefined}>
                    <span className={styles.valueAmount}>
                      {isLowQuota(account.remainingPercent) && lowMark}
                      {/* An account without this limit says so in the value slot, once. */}
                      {account.status === 'no-limit' ? (
                        <span className={styles.noLimitValue}>{noLimitLabel}</span>
                      ) : account.remainingPercent === null ? (
                        '—'
                      ) : (
                        percent(account.remainingPercent)
                      )}
                    </span>
                    {/* Phones have no column heading over this value, so it names its limit. */}
                    {account.status !== 'no-limit' && (
                      <span className={styles.valueCaption}>{windowLabel}</span>
                    )}
                  </strong>
                  {account.windows.length > 0 && (
                    <ul className={styles.limits} aria-label={t('quota_pool.limits')}>
                      {/* Wide screens keep one column per limit, so a limit this account lacks is a visible gap.
                          Phones show only the active window's gap, as its block, ahead of the other limits. */}
                      {limitColumns
                        .filter(
                          (column) =>
                            column.id === countedLimitId &&
                            !account.windows.some((limit) => limit.id === column.id)
                        )
                        .map((column) => missingLimit(account, column))}
                      {[...account.windows]
                        .sort(
                          (a, b) =>
                            Number(b.id === countedLimitId) - Number(a.id === countedLimitId)
                        )
                        .map((limit) => {
                          const colIndex = limitColumns.findIndex(
                            (column) => column.id === limit.id
                          );
                          return (
                            <li
                              key={limit.id}
                              data-limit-id={limit.id}
                              data-low={isLowQuota(limit.remainingPercent)}
                              data-unavailable={limit.remainingPercent === null || undefined}
                              data-counted={limit.id === countedLimitId || undefined}
                              data-last-col={colIndex === limitColumns.length - 1 || undefined}
                              style={
                                {
                                  '--col': colIndex + 1,
                                } as CSSProperties
                              }
                            >
                            <span>{limitLabel(limit)}</span>
                            <strong>
                              {/* The slot holds this row's Low mark; hidden ghosts size it to the column's Low mark.
                                  Unavailable cells span their own value slot without widening healthy rows. */}
                              {/* A column widened only for an Unavailable row has no Low slot to reserve, so its
                                  bars all run to the cell's end. */}
                              {(columnStatus.get(limit.id)?.low || limit.remainingPercent === null) && (
                                <span className={styles.limitStatus}>
                                  {isLowQuota(limit.remainingPercent) && lowMark}
                                  {limit.remainingPercent === null && (
                                    <span className={styles.unavailableWord}>
                                      <IconAlertTriangle size={14} aria-hidden="true" />
                                      {t('quota_pool.value_unavailable')}
                                    </span>
                                  )}
                                  {columnStatus.get(limit.id)?.low && limit.remainingPercent !== null && (
                                    <span
                                      className={styles.statusGhost}
                                      data-word={t('quota_pool.limit_low')}
                                      aria-hidden="true"
                                    />
                                  )}
                                </span>
                              )}
                              {limit.remainingPercent !== null && (
                                <span className={styles.limitValue}>
                                  {percent(limit.remainingPercent)}
                                </span>
                              )}
                            </strong>
                            {/* A missing value gets an empty dashed track (phones), so it can't read as 0%. */}
                            <span
                              className={styles.limitBar}
                              data-empty={limit.remainingPercent === null || undefined}
                              aria-hidden="true"
                            >
                              {limit.remainingPercent !== null && (
                                <span style={{ width: `${limit.remainingPercent}%` }} />
                              )}
                            </span>
                            {limit.resetAtMs !== null && (
                              <small>
                                {t('quota_pool.limit_resets', { date: date(limit.resetAtMs) })}
                              </small>
                            )}
                            </li>
                          );
                        })}
                      {limitColumns
                        .filter(
                          (column) =>
                            column.id !== countedLimitId &&
                            !account.windows.some((limit) => limit.id === column.id)
                        )
                        .map((column) => missingLimit(account, column))}
                    </ul>
                  )}
                </summary>
                <div className={styles.accountFacts}>
                  {/* The page lays out its own sections as three cards: Usage (with the burn rate
                      in its title strip), Billing and Manual resets, the one accent card (G12). */}
                  <div className={styles.factsLayout}>
                    {/* One reset section per open row; the keys let it move without remounting. */}
                    {stackedFacts && resetSection(account)}
                    {/* Usage carries the burn rate in its title strip, as its lead figure (G12). */}
                    <FactSection
                      key="usage"
                      title={
                        <>
                          <span className={styles.cardTitle}>
                            {t('quota_pool.facts_usage')}
                            <span className={styles.cardTitleAside}>
                              {' · '}
                              {t('quota_pool.burn_last', { hours: dashboard.lookbackHours })}
                            </span>
                          </span>
                          <span className={styles.burnDock}>
                            {account.burnPointsPerHour !== null ? (
                              <>
                                <strong>{number(account.burnPointsPerHour)}</strong>{' '}
                                <span>{t('quota_pool.points_hour')}</span>
                              </>
                            ) : (
                              <span data-state="notReported">{t('quota_pool.not_reported')}</span>
                            )}
                          </span>
                        </>
                      }
                    >
                      <Fact
                        label={t('quota_pool.observed')}
                        {...(account.observedAtMs !== null
                          ? { state: 'known' as const, value: date(account.observedAtMs) }
                          : {
                              state: 'notReported' as const,
                              reason: t('quota_pool.usage_not_reported_reason'),
                            })}
                      />
                      {!account.windows.some((limit) => limit.resetAtMs === account.resetAtMs) && (
                        <Fact
                          label={t('quota_pool.account_reset', { window: windowLabel })}
                          {...(account.resetAtMs !== null
                            ? { state: 'known' as const, value: date(account.resetAtMs) }
                            : {
                                state: 'notReported' as const,
                                reason: t('quota_pool.reset_time_not_reported_reason'),
                              })}
                        />
                      )}
                      <Fact
                        label={t(
                          dashboard.window === 'weekly'
                            ? 'quota_pool.predicted_empty_weekly'
                            : 'quota_pool.predicted_empty_five_hour'
                        )}
                        {...(pool.forecastState === 'ready' && account.status === 'ok'
                          ? {
                              state: 'known' as const,
                              value: forecastDate(account.emptyAtMs, true),
                            }
                          : {
                              state: 'notReported' as const,
                              reason: t('quota_pool.forecast_not_reported_reason'),
                            })}
                      />
                    </FactSection>
                    <FactSection key="billing" title={t('quota_pool.facts_billing')}>
                      <BillingFacts
                        billing={account.billing ?? null}
                        nowMs={dashboard.nowMs}
                        formatDate={date}
                        basisOverrides={ESTIMATE_BASIS_OVERRIDES}
                      />
                    </FactSection>
                    {!stackedFacts && resetSection(account)}
                  </div>
                </div>
              </details>
            ))
          )}
        </div>
        {pageAccounts.length < visibleAccounts.length && (
          <div className={styles.rosterFooter}>
            <button
              type="button"
              className={`${styles.expandAccounts} ${styles.showAll}`}
              onClick={() => setShowAll(true)}
            >
              {t('quota_pool.show_more_accounts', {
                count: visibleAccounts.length - pageAccounts.length,
              })}
            </button>
          </div>
        )}
        {/* After the list and its Show more footer, shown only while an estimated renewal is open. */}
        {hasOpenEstimatedRenewal && (
          <p className={styles.renewalCaveat}>{t('quota_pool.billing_estimate_caveat')}</p>
        )}
      </section>
    </article>
  );
}
