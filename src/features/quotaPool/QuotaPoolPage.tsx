import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconEye,
  IconClock,
  IconSlidersHorizontal,
  IconChevronDown,
  IconChevronLeft,
  IconFilterAll,
} from '@/components/ui/icons';
import type { PoolQuery } from '@/services/api/quotaPool';
import { poolProviderViewId } from '@/domain/quotaPool/providers';
import type { PoolProfileUpdate } from '@/domain/quotaPool/types';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh, useReportHeaderRefreshBusy } from '@/hooks/useHeaderRefresh';
import { usePoolDashboard } from './usePoolDashboard';
import { useServerAccountsPoller } from './useServerQuota';
import { usePhoneChipLine } from './usePhoneChipLine';
import { PoolCard } from './PoolCard';
import { CombinedPoolCard } from './CombinedPoolCard';
import { movePool, orderPools, poolKey, usePoolOrder } from './poolOrder';
import { PoolProviderMark } from './PoolProviderMark';
import { poolProviderLabel, poolProviderStyle } from './providerPresentation';
import { DiscoveredQuota } from './DiscoveredQuota';
import { viewRange } from './chartGeometry';
import {
  forecastMultiplier,
  readViewState,
  resolveViewProvider,
  sameView,
  visibleProviders,
  writeViewState,
  type QuotaViewState,
} from './model/viewState';
import {
  formatPoolDate,
  formatPoolNumber,
  providerAccountCount,
} from './presentation';
import { usePrivacyStore } from '@/stores/usePrivacyStore';
import styles from './QuotaPoolPage.module.scss';

/** Points per plan (server/quota/plans.ts), listed in About so each weight reads on its own line. */
const PLAN_WEIGHTS = [
  ['Claude Pro · ChatGPT Plus', 100],
  ['Claude Max · Google AI Ultra Lite', 500],
  ['ChatGPT Pro', 1000],
  ['Claude Ultra · Google AI Ultra', 2000],
  ['ChatGPT Pro 500', 2500],
] as const;

export function QuotaPoolPage() {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsToggleRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const todayPressedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const poolsRef = useRef<HTMLDivElement>(null);
  const chipLine = usePhoneChipLine(poolsRef);
  const { t, i18n } = useTranslation();
  // Pool, window, measure and the two settings live in the address, so a link opens this view.
  // The view is state first, so a click repaints at once; the address follows it, and a link or
  // Back changes the view.
  const [params, setParams] = useSearchParams();
  const address = params.toString();
  const [view, setViewState] = useState(() => readViewState(params));
  const { provider, mode } = view;
  const setView = (patch: Partial<QuotaViewState>) =>
    setViewState((current) => ({ ...current, ...patch }));
  useEffect(() => {
    const next = readViewState(new URLSearchParams(address));
    setViewState((current) => (sameView(current, next) ? current : next));
  }, [address]);
  useEffect(() => {
    setParams(
      (previous) => {
        const next = writeViewState(previous, view);
        return next.toString() === previous.toString() ? previous : next;
      },
      { replace: true }
    );
  }, [view, setParams]);
  // The date offset is relative to today, so it is not shared. "Show emails" is private: it stays
  // out of the address and is one choice per browser, shared with Analytics.
  const [local, setLocal] = useState({ offsetDays: 0 });
  const reveal = usePrivacyStore((state) => state.revealEmails);
  const setReveal = usePrivacyStore((state) => state.setRevealEmails);
  const query: PoolQuery = {
    window: view.window,
    lookback: view.lookback,
    multiplier: forecastMultiplier(view),
    ...local,
    reveal,
  };
  const state = usePoolDashboard(query);
  // Whether a Claude account is served from the history server (its resets row then does not poll
  // the hub) is known once the accounts poller has asked: hold it while this page is open.
  useServerAccountsPoller();
  const { data, refresh, saveProfile } = state;
  const saveDiscoveredProfile = async (profile: PoolProfileUpdate) => {
    const saved = await saveProfile(profile);
    if (saved) headingRef.current?.focus({ preventScroll: true });
    return saved;
  };
  const refreshPool = useCallback((accountId?: string) => void refresh(accountId), [refresh]);
  const refreshStatus = state.refreshStatus ?? data;
  const refreshing = state.refreshing || refreshStatus?.refreshing;
  const chartUnavailable = !data?.pools.length;
  const showSkeleton = !data && state.loading && state.connected;
  const { order, setOrder } = usePoolOrder();
  const orderedPools = data ? orderPools(data.pools, order) : [];
  const providerChoices = visibleProviders(data?.pools);
  const activeProvider = data ? resolveViewProvider(provider, providerChoices) : provider;
  useEffect(() => {
    if (data && activeProvider !== provider) {
      setViewState((current) =>
        current.provider === provider ? { ...current, provider: activeProvider } : current
      );
    }
  }, [data, activeProvider, provider]);
  const shownPools = orderedPools.filter(
    (pool) => activeProvider === 'all' || activeProvider === poolProviderViewId(pool.provider)
  );
  // Wide tables give the Manual resets column room for two kinds ("1 weekly · 2 Fable held") when no
  // card has more than two limit columns; every card shares the width, so their columns line up (G11).
  const wideResets = shownPools.every(
    (pool) =>
      new Set(pool.accounts.flatMap((account) => account.windows.map((limit) => limit.id))).size <= 2
  );
  const providerName = (id: string) =>
    poolProviderLabel(
      t,
      id,
      data?.pools.find((pool) => pool.provider === id)?.displayName ??
        data?.unpooled?.find((entry) => entry.provider === id)?.displayName
    );
  const refreshFromHeader = useCallback(async () => {
    if (!(await refresh())) throw new Error(t('quota_pool.refresh_error'));
  }, [refresh, t]);
  useHeaderRefresh(refreshFromHeader, state.connected);
  useReportHeaderRefreshBusy(Boolean(refreshing) || (!data && state.loading));
  const date = (value: number | null, short = false) => formatPoolDate(value, i18n.language, short);
  // The span the charts show, which the 5-hour and rate views narrow.
  const range = data ? viewRange(data, mode) : null;
  const change = <K extends keyof typeof local>(key: K, value: (typeof local)[K]) =>
    setLocal((current) => ({ ...current, [key]: value }));
  // Phones show the options as an overlay: focus enters it on open, and Escape or a tap outside
  // closes it. A tap that lands on nothing focusable returns focus to the button. The toolbar
  // remounts after a reload, so toolbarShown re-runs this and focus re-enters the open overlay.
  const toolbarShown = !chartUnavailable;
  useEffect(() => {
    if (!optionsOpen) return;
    optionsRef.current?.querySelector<HTMLElement>('button, select')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOptionsOpen(false);
      optionsToggleRef.current?.focus();
    };
    const onClick = (event: MouseEvent) => {
      // Changing the window or interval unmounts the toolbar until the new data arrives, so a click's
      // target can already be detached and the refs stale: match by id along the dispatch path.
      const inside = (node: EventTarget) =>
        node instanceof Element &&
        (node.id === 'pool-view-options' ||
          node.getAttribute('aria-controls') === 'pool-view-options');
      if (event.composedPath().some(inside)) return;
      setOptionsOpen(false);
      if (document.activeElement === document.body) optionsToggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick);
    };
  }, [optionsOpen, toolbarShown]);
  // Today unmounts once it has done its job, and so does the whole toolbar while the new range loads,
  // so keyboard focus goes to the label when it next mounts.
  const focusTodayState = useCallback((node: HTMLSpanElement | null) => {
    if (!node || !todayPressedRef.current) return;
    todayPressedRef.current = false;
    node.focus();
  }, []);
  // The Options button spells out every current choice on one line at 390px ("Weekly · Remaining · 3h
  // avg · Future: same"); Future is always named, so its value never reads as a setting of its own,
  // and rate views say it is off, as the wide toolbar's control does (G11).
  const optionsSummary = [
    t(`quota_pool.${view.window === 'weekly' ? 'weekly' : 'five_hour'}`),
    t(`quota_pool.${mode}`),
    t('quota_pool.options_avg', { hours: view.lookback }),
    mode !== 'remaining'
      ? t('quota_pool.options_future_off')
      : view.future === 1
        ? t('quota_pool.options_future_same')
        : `${t('quota_pool.future_prefix')}: ${t(
            `quota_pool.scenario.${view.future === 0.5 ? 'half' : view.future === 2 ? 'double' : 'idle'}`
          )}`,
  ].join(' · ');

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <h1 ref={headingRef} tabIndex={-1}>
            {t('quota_pool.title')}
          </h1>
          {/* Only once accounts exist: an empty or failed page has one action, in its card. */}
          {data && data.pools.length > 0 && (
            <Link to="/quota/accounts" className={styles.accountLink}>
              {/* Phones keep the short name so the link fits beside the title. */}
              <span className={styles.linkLong}>{t('quota_pool.accounts_link')}</span>
              <span className={styles.linkShort}>{t('quota_pool.accounts')}</span>{' '}
              <span aria-hidden="true">→</span>
            </Link>
          )}
          {/* Phones: the Accounts link's place, so the rows below start where the loaded page's do. */}
          {showSkeleton && <Skeleton className={styles.loadingLink} rounded={999} />}
        </div>
        <div className={styles.actions}>
          {!chartUnavailable && (
            <label className={styles.privacy}>
              <input
                type="checkbox"
                checked={query.reveal}
                onChange={(event) => setReveal(event.target.checked)}
              />
              <IconEye size={18} aria-hidden="true" />
              {t('quota_pool.show_emails')}
            </label>
          )}
          {/* Manual refresh is the header's refresh button; this shows when the next automatic one runs.
              When a refresh fails, the retry countdown moves into the warning banner beside Try again. */}
          {Boolean(data?.pools.length) && !state.refreshError && (
            <RefreshCountdown
              dueAtMs={state.nextCollectAtMs}
              refreshing={Boolean(refreshing)}
              retrying={false}
            />
          )}
          {/* Loading status sits directly in the header utility row so it is the first readable
              line on both phones and desktop without shifting the skeleton controls below. */}
          {showSkeleton && (
            <span className={styles.loadingHeaderStatus} role="status">
              <span className={styles.loadingDot} />
              {t('quota_pool.loading')}
            </span>
          )}
          {/* Phones: Show emails and Auto-refresh, as their own row. */}
          {showSkeleton && (
            <span className={styles.loadingActionsSkeleton} aria-hidden="true" inert>
              <Skeleton
                className={styles.loadingAction}
                rounded={999}
                data-skeleton-row="utility"
              />
              <Skeleton className={styles.loadingAction} rounded={999} />
            </span>
          )}
        </div>
      </header>
      {!chartUnavailable && (
        <div className={styles.controls}>
          <div className={styles.providerBar} role="group" aria-label={t('quota_pool.providers')}>
            {providerChoices.map((item) => {
              const pool =
                item === 'all'
                  ? undefined
                  : data?.pools.find((entry) => poolProviderViewId(entry.provider) === item);
              const providerId = pool?.provider ?? item;
              return (
                <button
                  type="button"
                  key={item}
                  aria-pressed={activeProvider === item}
                  onClick={() => setView({ provider: item })}
                  {...(item === 'all' ? {} : poolProviderStyle(providerId))}
                >
                  {item !== 'all' && <PoolProviderMark provider={providerId} />}
                  {item === 'all' && <IconFilterAll size={18} aria-hidden="true" />}
                  {poolProviderLabel(t, providerId, pool?.displayName)}
                  {item !== 'all' && data && (
                    <span className={styles.count}>
                      {providerAccountCount(data.pools, providerId)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className={styles.dateNavigation}>
            <span className={styles.dateRange}>
              {range ? `${date(range.fromMs, true)} – ${date(range.toMs, true)}` : null}
              {/* When already on the current range, pair "Current" with the date readout instead
                  of trapping bare text between the two circular step buttons. */}
              {query.offsetDays === 0 && (
                <>
                  <span className={styles.dateDot} aria-hidden="true">
                    ·
                  </span>
                  <span
                    className={styles.todayState}
                    ref={focusTodayState}
                    tabIndex={-1}
                    title={t('quota_pool.today_current')}
                  >
                    {t('quota_pool.today_state')}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              className={styles.dateStep}
              aria-label={t('quota_pool.previous')}
              disabled={query.offsetDays <= -14}
              onClick={() => change('offsetDays', query.offsetDays - 1)}
            >
              <IconChevronLeft size={18} aria-hidden="true" />
            </button>
            {query.offsetDays !== 0 && (
              <button
                type="button"
                className={styles.today}
                onClick={() => {
                  todayPressedRef.current = true;
                  change('offsetDays', 0);
                }}
              >
                {t('quota_pool.today')}
              </button>
            )}
            <button
              type="button"
              className={styles.dateStep}
              aria-label={t('quota_pool.next')}
              disabled={query.offsetDays >= 14}
              onClick={() => change('offsetDays', query.offsetDays + 1)}
            >
              <IconChevronLeft size={18} className={styles.nextIcon} aria-hidden="true" />
            </button>
            {/* Phones fold the view settings behind this button, which spells out the current
                  choices; its name is that visible text, so "Options" is the description. */}
            <button
              type="button"
              ref={optionsToggleRef}
              className={styles.optionsToggle}
              aria-expanded={optionsOpen}
              aria-controls="pool-view-options"
              title={t('quota_pool.view_options')}
              onClick={() => setOptionsOpen((open) => !open)}
            >
              <IconSlidersHorizontal size={16} aria-hidden="true" />
              <span>{optionsSummary}</span>
              <IconChevronDown className={styles.optionsChevron} size={16} aria-hidden="true" />
            </button>
          </div>
          <fieldset className={styles.toolbar} aria-label={t('quota_pool.chart_mode')}>
            {/* Phones fold everything below into one overlay under the Options button; from 641px
                this wrapper is transparent to layout. */}
            <div
              className={styles.viewOptions}
              id="pool-view-options"
              ref={optionsRef}
              data-open={optionsOpen || undefined}
            >
              <span className={styles.groupLabel} aria-hidden="true">
                {t('quota_pool.option_window')}
              </span>
              <div
                className={styles.segment}
                role="group"
                aria-label={t('quota_pool.option_window')}
              >
                {(['weekly', 'five-hour'] as const).map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-pressed={query.window === item}
                    onClick={() => setView({ window: item })}
                  >
                    {t(`quota_pool.${item === 'weekly' ? 'weekly' : 'five_hour'}`)}
                  </button>
                ))}
              </div>
              <span className={styles.groupLabel} aria-hidden="true">
                {t('quota_pool.option_measure')}
              </span>
              <div
                className={styles.segment}
                role="group"
                aria-label={t('quota_pool.option_measure')}
              >
                {(['remaining', 'drain', 'burn'] as const).map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-pressed={mode === item}
                    onClick={() => setView({ mode: item })}
                  >
                    {t(`quota_pool.${item}`)}
                  </button>
                ))}
              </div>
              <div className={styles.chartSettings}>
                {/* The setting's name sits inside the box, so every toolbar control shares one top edge.
                  The visible name is also the accessible one. */}
                <label className={styles.selectLabel}>
                  <span className={styles.selectPrefix}>{t('quota_pool.rate_prefix')}</span>
                  <select
                    value={query.lookback}
                    onChange={(event) =>
                      setView({
                        lookback: Number(event.target.value) as QuotaViewState['lookback'],
                      })
                    }
                  >
                    {([1, 3, 6] as const).map((hours) => (
                      <option key={hours} value={hours}>
                        {t('quota_pool.hours', { hours })}
                      </option>
                    ))}
                  </select>
                </label>
                {/* The scenario only shapes the Remaining forecast. Rate views keep the control in its
                    place, off, and its one choice says why, so the row never changes shape (G11). */}
                <label className={styles.selectLabel}>
                  <span className={styles.selectPrefix}>{t('quota_pool.future_prefix')}</span>
                  {mode === 'remaining' ? (
                    <select
                      value={query.multiplier}
                      onChange={(event) =>
                        setView({ future: Number(event.target.value) as QuotaViewState['future'] })
                      }
                    >
                      {([1, 0.5, 2, 0] as const).map((value) => (
                        <option value={value} key={value}>
                          {t(
                            `quota_pool.scenario.${value === 1 ? 'same' : value === 0.5 ? 'half' : value === 2 ? 'double' : 'idle'}`
                          )}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select disabled value="off">
                      <option value="off">{t('quota_pool.future_remaining_only')}</option>
                    </select>
                  )}
                </label>
              </div>
            </div>
          </fieldset>
        </div>
      )}
      {!state.connected && (
        <div className={styles.notice} role="status">
          {t('quota_pool.disconnected')}
        </div>
      )}
      {(state.error || state.refreshError) && (
        <div
          className={`${styles.notice} ${styles.errorNotice}`}
          role="alert"
          data-alone={!data || undefined}
        >
          <div>
            <h2>
              {/* Red only when nothing loaded; over saved data the failure is a warning. */}
              <IconAlertTriangle
                size={18}
                className={data ? styles.warningIcon : styles.errorIcon}
                aria-hidden="true"
              />
              {t(`quota_pool.${data ? 'refresh_failed_title' : 'load_failed_title'}`)}
            </h2>
            {/* Say what went wrong in plain words before the saved-data line and the code. */}
            {state.refreshError && (
              <p>
                {t(
                  state.refreshErrorStatus === null || state.refreshErrorStatus >= 500
                    ? 'quota_pool.refresh_cause'
                    : 'quota_pool.refresh_cause_error'
                )}
              </p>
            )}
            <p>
              {/* A failed refresh says how old the data still on screen is, keeping date+time whole. */}
              {state.refreshError && data
                ? t('quota_pool.refresh_error_dated', {
                    date: date(data.nowMs).replace(/ /g, '\u00a0'),
                  })
                : t(
                    `quota_pool.${state.refreshError ? 'refresh_error' : data ? 'load_error' : 'load_error_initial'}`
                  )}
            </p>
            <p className={styles.errorCause}>
              {(state.refreshError ? state.refreshErrorStatus : state.errorStatus) === null
                ? t('quota_pool.error_network')
                : t('quota_pool.error_status', {
                    status: state.refreshError ? state.refreshErrorStatus : state.errorStatus,
                  })}
            </p>
          </div>
          <div className={styles.errorActions}>
            <button
              type="button"
              onClick={() => void (state.refreshError ? state.refresh() : state.reload())}
            >
              {t('quota_pool.retry')}
            </button>
            {state.refreshError && Boolean(data?.pools.length) && (
              <RefreshCountdown
                dueAtMs={state.nextCollectAtMs}
                refreshing={Boolean(refreshing)}
                retrying
              />
            )}
          </div>
        </div>
      )}
      {data?.issues.map((issue) => (
        <div
          className={styles.notice}
          role="status"
          key={`${issue.instanceId ?? 'legacy'}-${issue.provider}-${issue.code}`}
        >
          {issue.sourceLabel && `${issue.sourceLabel} · `}
          {providerName(issue.provider)}: {t(`quota_pool.issue.${issue.code}`)}
        </div>
      ))}
      {data?.combinations?.map((combination) => (
        <p className={styles.notice} role="status" key={combination.provider}>
          {t('provider_sources.separate_pools', {
            provider: providerName(combination.provider),
          })}
        </p>
      ))}
      {Boolean(data?.unresolvedHistoryAccountCount) && (
        <p className={styles.notice} role="status">
          {t('provider_sources.unresolved_history')}
        </p>
      )}
      {showSkeleton && (
        <>
          {/* Placeholders shaped like the toolbar that will render: pool tabs, two view
              toggles, the two settings boxes and the date navigator, all on one top edge.
              Phones show the loaded rows instead: tabs, date, then the Options button. */}
          <div className={styles.loadingControls} aria-hidden="true" inert>
            <div className={styles.loadingRow} data-skeleton-row="tabs">
              {[104, 92, 92].map((width, index) => (
                <Skeleton key={index} width={width} height={40} rounded={999} />
              ))}
            </div>
            <div className={styles.loadingRow}>
              <Skeleton className={styles.loadingSegment} height={44} rounded={999} />
              <Skeleton className={styles.loadingSegmentWide} height={44} rounded={999} />
              <span className={styles.loadingSelects}>
                {[100, 184].map((width, index) => (
                  <Skeleton key={index} width={width} height={46} rounded={999} />
                ))}
              </span>
              <Skeleton
                className={styles.loadingDate}
                height={40}
                rounded={999}
                data-skeleton-row="date"
              />
              <Skeleton
                className={styles.loadingOptions}
                rounded={999}
                data-skeleton-row="options"
              />
            </div>
          </div>
          <div className={styles.loading} aria-busy="true" data-skeleton-row="card">
            <div className={styles.loadingHead}>
              <h2>{t('quota_pool.combined_usage')}</h2>
              <Skeleton className={styles.loadingToggle} rounded={999} inert />
            </div>
            {/* The combined card has a label-above-value headline in a number card, matching loaded cards. */}
            <div className={`${styles.loadingHero} ${styles.loadingHeroCard}`}>
              <span className={styles.loadingNumber}>
                <Skeleton width={150} height={14} rounded={4} />
                <Skeleton width={180} height={42} rounded={8} />
              </span>
            </div>
            <Skeleton height={168} rounded={8} />
          </div>
          {/* One placeholder per provider card, in the card's own order: headline and facts,
              chart, then the first account rows. */}
          {(['claude', 'codex'] as const).map((item) => (
            <div key={item} className={styles.loading} aria-hidden="true" inert>
              <div className={styles.loadingIdentity}>
                <h2 className={styles.loadingTitle}>
                  <PoolProviderMark provider={item} />
                  {t(`quota_pool.${item}`)}
                </h2>
                {/* The account count and status chip; wide screens put the action pills on this row too. */}
                <Skeleton className={styles.loadingCount} rounded={4} />
                <Skeleton className={styles.loadingChip} rounded={999} />
                <span className={styles.loadingPills}>
                  <Skeleton className={styles.loadingPill} rounded={999} />
                  <Skeleton className={styles.loadingPill} rounded={999} />
                </span>
              </div>
              {/* The loaded header's two cards: the number with Now docked under it, then Forecast (G12). */}
              <div className={styles.loadingStats} data-rate={mode !== 'remaining' || undefined}>
                <span className={styles.loadingCard}>
                  <span className={styles.loadingNumber}>
                    <Skeleton width={140} height={14} rounded={4} />
                    <Skeleton width={170} height={42} rounded={8} />
                  </span>
                  <span className={styles.loadingFact}>
                    <Skeleton width={84} height={10} rounded={4} />
                    <Skeleton width={128} height={16} rounded={4} />
                  </span>
                </span>
                <span className={styles.loadingCard}>
                  <Skeleton className={styles.loadingCardTitle} width={64} height={12} rounded={4} />
                  {[0, 1, 2].map((index) => (
                    <span key={index} className={styles.loadingFact}>
                      <Skeleton width={84} height={10} rounded={4} />
                      <Skeleton width={128} height={16} rounded={4} />
                    </span>
                  ))}
                </span>
              </div>
              {/* Phones: the action pills follow the facts, right above the chart, as the loaded card's do (G11). */}
              <span className={styles.loadingPillsBelow}>
                <Skeleton className={styles.loadingPill} rounded={999} />
                <Skeleton className={styles.loadingPill} rounded={999} />
              </span>
              <Skeleton height={120} rounded={8} />
              <div className={styles.loadingRows}>
                {[0, 1].map((index) => (
                  <Skeleton key={index} height={36} rounded={8} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {data && shownPools.length > 0 && (
        <CombinedPoolCard
          pools={shownPools}
          dashboard={data}
          provider={activeProvider}
          mode={mode}
          savedData={state.error || state.refreshError}
          onRefresh={() => void refresh()}
        />
      )}
      <div
        ref={poolsRef}
        className={styles.pools}
        aria-busy={state.loading}
        data-chip-line={chipLine || undefined}
        data-wide-resets={wideResets || undefined}
      >
        {data &&
          shownPools.map((pool, index, shown) => (
            <PoolCard
              key={poolKey(pool)}
              onRefresh={refreshPool}
              pool={pool}
              dashboard={data}
              mode={mode}
              reveal={query.reveal}
              savedData={state.error || state.refreshError}
              move={
                activeProvider === 'all' && shown.length > 1
                  ? {
                      up:
                        index > 0 ? () => setOrder(movePool(shown, poolKey(pool), -1)) : undefined,
                      down:
                        index < shown.length - 1
                          ? () => setOrder(movePool(shown, poolKey(pool), 1))
                          : undefined,
                    }
                  : undefined
              }
            />
          ))}
        {data &&
          data.pools.length === 0 &&
          !data.awaitingAuth?.length &&
          !data.unpooled?.length && (
            <div className={`${styles.notice} ${styles.emptyNotice}`}>
              <h2>{t('quota_pool.no_accounts_title')}</h2>
              <p>{t('quota_pool.no_accounts_help')}</p>
              <Link to="/oauth" className={styles.accountLink}>
                {t('quota_pool.add_credentials')} <span aria-hidden="true">→</span>
              </Link>
            </div>
          )}
      </div>
      {data && <DiscoveredQuota dashboard={data} saveProfile={saveDiscoveredProfile} />}
      <footer className={styles.footer}>
        {data && data.pools.length > 0 && (
          <>
            <h2 className={styles.footerLabel}>{t('quota_pool.data_collection')}</h2>
            <dl className={styles.footerFacts}>
              <div>
                <dt>{t('quota_pool.history_since')}</dt>
                <dd>{date(data.historyStartedAtMs)}</dd>
              </div>
              <div>
                <dt>{t('quota_pool.last_refresh')}</dt>
                <dd>{date(refreshStatus?.lastRefreshAtMs ?? null)}</dd>
              </div>
            </dl>
            <details className={styles.about}>
              <summary>
                <IconChevronDown size={16} aria-hidden="true" />
                {t('quota_pool.about_numbers')}
              </summary>
              <ul>
                <li>
                  {t('quota_pool.normalized_intro')}
                  <dl className={styles.planWeights}>
                    {PLAN_WEIGHTS.map(([plan, points]) => (
                      <div key={plan}>
                        <dt>{plan}</dt>
                        <dd>
                          {formatPoolNumber(points, i18n.language)} {t('quota_pool.points')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
                <li>{t('quota_pool.combined_lanes_about')}</li>
                <li>{t('quota_pool.rates_note')}</li>
                <li>{t('quota_pool.limit_note')}</li>
                <li>{t('quota_pool.polling')}</li>
              </ul>
            </details>
          </>
        )}
      </footer>
    </div>
  );
}

/** Seconds until the page's next automatic collection, ticking once a second. */
function RefreshCountdown({
  dueAtMs,
  refreshing,
  retrying,
}: {
  dueAtMs: number | null;
  refreshing: boolean;
  /** After a failed refresh the next automatic one is a retry, and says so. */
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (dueAtMs === null) return null;
  return (
    <span className={styles.countdown} data-refreshing={refreshing} role="status">
      {/* A clock for the countdown. While a collection runs the header's refresh button spins, so
          this stays plain status text: one progress indicator on the page (G11). */}
      {!refreshing && <IconClock size={16} aria-hidden="true" />}
      {refreshing
        ? t('quota_pool.refreshing')
        : t(`quota_pool.${retrying ? 'auto_retry_in' : 'auto_refresh_in'}`, {
            seconds: Math.max(0, Math.ceil((dueAtMs - now) / 1000)),
          })}
    </span>
  );
}
