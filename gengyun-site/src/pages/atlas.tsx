import * as React from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  Leaf,
  MapPin,
  Search,
  ShieldAlert,
  Sprout,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FavoriteButton } from "@/components/favorite-button";
import { Link } from "@/lib/router";
import { atlas, controlTiming, provinceIndex } from "@/lib/data";
import type {
  AtlasHerbicide,
  AtlasRecord,
  AtlasWeed,
  ControlTimingEntry,
  ProvinceEntry,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type TabKey = "herbicide" | "weed" | "record" | "timing" | "province";

const TABS: { key: TabKey; label: string; count: number }[] = [
  { key: "herbicide", label: "除草剂", count: atlas.herbicides.length },
  { key: "weed", label: "田间杂草", count: atlas.weeds.length },
  { key: "record", label: "登记样本", count: atlas.records.length },
  { key: "timing", label: "防除时期", count: controlTiming.items.length },
  { key: "province", label: "省份索引", count: provinceIndex.items.length },
];

function hazardTone(level: string) {
  if (level.includes("高危") || level.includes("高")) {
    return "border-[#e2b6ad] bg-[#fbeae6] text-[var(--gy-danger)]";
  }
  if (level.includes("中")) {
    return "border-[#ead6ae] bg-[var(--gy-amber-soft)] text-[var(--gy-amber)]";
  }
  return "border-[var(--site-border)] bg-[var(--gy-green-soft)] text-[var(--gy-green-deep)]";
}

function matches(query: string, ...values: (string | undefined)[]) {
  if (!query) return true;
  return values.some((value) => (value ?? "").toLowerCase().includes(query));
}

export function AtlasPage() {
  const [tab, setTab] = React.useState<TabKey>("herbicide");
  const [query, setQuery] = React.useState("");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const detailRef = React.useRef<HTMLElement>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const herbicides = React.useMemo(
    () =>
      atlas.herbicides.filter((item) =>
        matches(
          normalizedQuery,
          item.name,
          item.aliases,
          item.targetWeeds,
          item.regions,
          item.hazardDetail,
        ),
      ),
    [normalizedQuery],
  );

  const weeds = React.useMemo(
    () =>
      atlas.weeds.filter((item) => matches(normalizedQuery, item.name, item.identifyKey)),
    [normalizedQuery],
  );

  const records = React.useMemo(
    () =>
      atlas.records.filter((item) =>
        matches(
          normalizedQuery,
          item.name,
          item.registrationNumber,
          item.producer,
          item.ingredients,
          item.useScene,
          item.target,
        ),
      ),
    [normalizedQuery],
  );

  const timingEntries = React.useMemo(
    () =>
      controlTiming.items.filter((item) =>
        matches(normalizedQuery, item.crop, item.window, item.weeds),
      ),
    [normalizedQuery],
  );

  const provinces = React.useMemo(
    () =>
      provinceIndex.items.filter((item) =>
        matches(normalizedQuery, item.province, item.region, item.weeds, item.crops),
      ),
    [normalizedQuery],
  );

  const activeList =
    tab === "herbicide"
      ? herbicides
      : tab === "weed"
        ? weeds
        : tab === "record"
          ? records
          : tab === "timing"
            ? timingEntries
            : provinces;

  const itemKey = (
    item:
      | AtlasHerbicide
      | AtlasWeed
      | AtlasRecord
      | ControlTimingEntry
      | ProvinceEntry,
  ) =>
    "registrationNumber" in item
      ? item.registrationNumber
      : "crop" in item
        ? item.crop
        : "province" in item
          ? item.province
          : item.name;

  const selectedKeyForList =
    selectedKey && activeList.some((item) => itemKey(item) === selectedKey)
      ? selectedKey
      : activeList[0]
        ? itemKey(activeList[0])
        : null;

  const activeHerbicide =
    tab === "herbicide"
      ? (herbicides.find((item) => item.name === selectedKeyForList) ?? herbicides[0])
      : undefined;
  const activeWeed =
    tab === "weed" ? (weeds.find((item) => item.name === selectedKeyForList) ?? weeds[0]) : undefined;
  const activeRecord =
    tab === "record"
      ? (records.find((item) => item.registrationNumber === selectedKeyForList) ?? records[0])
      : undefined;
  const activeTiming =
    tab === "timing"
      ? (timingEntries.find((item) => item.crop === selectedKeyForList) ?? timingEntries[0])
      : undefined;
  const activeProvince =
    tab === "province"
      ? (provinces.find((item) => item.province === selectedKeyForList) ?? provinces[0])
      : undefined;

  const selectItem = (key: string) => {
    setSelectedKey(key);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  const switchTab = (next: TabKey) => {
    setTab(next);
    setSelectedKey(null);
    setQuery("");
  };

  const totalResults = activeList.length;

  return (
    <div className="gy-shell">
      <header className="max-w-[64ch]">
        <span className="gy-kicker">识草查药 · FIELD ATLAS</span>
        <h1 className="mt-2 text-[29px] font-[650] leading-tight tracking-[-1px]">
          先认识草，再认识药。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          把田间杂草、除草剂风险和公开登记样本放在一起查。这里回答「它是什么、风险在哪、登记信息怎么说」，
          不回答「该打多少」。
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="gy-pill gy-pill--amber">种子演示数据 · 待核实 · 非权威</span>
        <span className="gy-pill gy-pill--plain">整理于 {atlas.retrievedAt}</span>
        <span className="gy-pill gy-pill--plain">不显示用量</span>
      </div>

      <section
        className="gy-stack mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5"
        aria-label="数据概况"
      >
        {[
          { icon: Leaf, label: "除草剂", value: atlas.herbicides.length },
          { icon: Sprout, label: "田间杂草", value: atlas.weeds.length },
          { icon: BookOpen, label: "登记样本", value: atlas.records.length },
          { icon: CalendarClock, label: "防除时期", value: controlTiming.items.length },
          { icon: MapPin, label: "省份索引", value: provinceIndex.items.length },
        ].map((item) => (
          <div key={item.label} className="gy-card flex items-center gap-3 px-4 py-3">
            <span className="grid size-10 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
              <item.icon className="size-5" aria-hidden="true" />
            </span>
            <div>
              <div className="text-[20px] font-bold leading-tight">{item.value}</div>
              <div className="text-[12px] text-[var(--site-muted)]">{item.label}</div>
            </div>
          </div>
        ))}
      </section>

      <div className="gy-toolbar mt-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" aria-label="数据类型" className="flex flex-wrap gap-2">
          {TABS.map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchTab(item.key)}
                className={cn(
                  "min-h-[42px] rounded-full border px-4 text-[14px] font-semibold",
                  active
                    ? "border-[var(--gy-green)] bg-[var(--gy-green)] text-white"
                    : "border-[var(--site-border)] bg-[var(--gy-cream)] text-[var(--site-fg)] hover:border-[var(--gy-green)]/40",
                )}
              >
                {item.label}
                <span
                  className={cn(
                    "ml-1.5 text-[12px] font-medium",
                    active ? "text-white/70" : "text-[var(--site-muted)]",
                  )}
                >
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full lg:max-w-[360px]">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--site-muted)]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              tab === "herbicide"
                ? "搜除草剂、别名、防治对象"
                : tab === "weed"
                  ? "搜杂草名称或识别要点"
                  : tab === "record"
                    ? "搜登记证号、药名、企业"
                    : tab === "timing"
                      ? "搜作物、时期或杂草对象"
                      : "搜省份、大区或常见杂草"
            }
            aria-label="搜索"
            className="gy-input pl-10 pr-10 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-[var(--site-muted)] hover:bg-[var(--gy-green-soft)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px] text-[var(--site-muted)]">
        <span>
          找到 <strong className="text-[var(--site-fg)]">{totalResults}</strong> 条
        </span>
        {query && <span>· 关键词「{query.trim()}」</span>}
        <span>· 点击条目查看详情</span>
      </div>

      <div className="gy-split mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <section
          aria-label={TABS.find((item) => item.key === tab)?.label}
          className="order-2 min-w-0 lg:order-1"
        >
          {totalResults === 0 ? (
            <div className="gy-card grid min-h-[240px] place-items-center p-8 text-center">
              <div>
                <Search className="mx-auto size-8 text-[var(--site-muted)]" aria-hidden="true" />
                <h2 className="mt-3 text-[18px] font-semibold">没有找到匹配的记录</h2>
                <p className="mt-1 text-[13px] text-[var(--site-muted)]">
                  换一个名称或关键词试试，或清空搜索查看全部。
                </p>
                <Button
                  variant="outline"
                  className="mt-4 min-h-[40px] rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-4"
                  onClick={() => setQuery("")}
                >
                  清空搜索
                </Button>
              </div>
            </div>
          ) : (
            <ul className="gy-card max-h-[560px] divide-y divide-[var(--site-border)] overflow-y-auto scrollbar-thin">
              {tab === "herbicide" &&
                herbicides.map((item) => (
                  <HerbicideRow
                    key={item.name}
                    item={item}
                    active={item.name === selectedKeyForList}
                    onSelect={() => selectItem(item.name)}
                  />
                ))}
              {tab === "weed" &&
                weeds.map((item) => (
                  <WeedRow
                    key={item.name}
                    item={item}
                    active={item.name === selectedKeyForList}
                    onSelect={() => selectItem(item.name)}
                  />
                ))}
              {tab === "record" &&
                records.map((item) => (
                  <RecordRow
                    key={item.registrationNumber}
                    item={item}
                    active={item.registrationNumber === selectedKeyForList}
                    onSelect={() => selectItem(item.registrationNumber)}
                  />
                ))}
              {tab === "timing" &&
                timingEntries.map((item) => (
                  <TimingRow
                    key={item.crop}
                    item={item}
                    active={item.crop === selectedKeyForList}
                    onSelect={() => selectItem(item.crop)}
                  />
                ))}
              {tab === "province" &&
                provinces.map((item) => (
                  <ProvinceRow
                    key={item.province}
                    item={item}
                    active={item.province === selectedKeyForList}
                    onSelect={() => selectItem(item.province)}
                  />
                ))}
            </ul>
          )}
        </section>

        <aside
          ref={detailRef}
          className="order-1 scroll-mt-24 lg:sticky lg:top-24 lg:order-2"
          aria-label="详情"
        >
          {tab === "herbicide" && activeHerbicide && (
            <HerbicideDetail item={activeHerbicide} />
          )}
          {tab === "weed" && activeWeed && <WeedDetail item={activeWeed} />}
          {tab === "record" && activeRecord && <RecordDetail item={activeRecord} />}
          {tab === "timing" && activeTiming && <TimingDetail item={activeTiming} />}
          {tab === "province" && activeProvince && <ProvinceDetail item={activeProvince} />}
        </aside>
      </div>

      <section className="mt-8 gy-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert
            className="mt-0.5 size-5 shrink-0 text-[var(--gy-amber)]"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-[16px] font-bold text-[var(--gy-amber)]">数据边界</h2>
            <p className="mt-1 text-[13px] leading-6 text-[#7c4a10]">{atlas.sourceNotice}</p>
            <p className="mt-1 text-[12px] leading-6 text-[#7c4a10]/85">
              整理稿没有逐条权威出处标注，登记样本仅供演示；查到的任何信息都不能代替包装标签、
              官方登记和当地农技意见，本页不提供用量与施用方法。
            </p>
          </div>
        </div>
      </section>

      <div className="mt-6 flex flex-col gap-3 rounded-[10px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] leading-6 text-[var(--site-muted)]">
          查清楚是什么之后，还要回到手边这瓶药：核对标签，才是用药前的最后一步。
        </p>
        <Button
          asChild
          className="min-h-[44px] shrink-0 rounded-full bg-[var(--gy-green)] px-5 text-white hover:bg-[var(--gy-green-deep)]"
        >
          <Link to="/identify">
            去核对标签
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function HerbicideRow({
  item,
  active,
  onSelect,
}: {
  item: AtlasHerbicide;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
          active ? "bg-[var(--gy-green-soft)]" : "hover:bg-[var(--gy-cream)]",
        )}
      >
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
          <Leaf className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold">{item.name}</span>
            <span className={cn("gy-pill min-h-[24px] px-2 text-[11px]", hazardTone(item.hazardLevel))}>
              {item.hazardLevel}
            </span>
          </span>
          <span className="mt-1 block truncate text-[12px] text-[var(--site-muted)]">
            别名：{item.aliases}
          </span>
          <span className="mt-1 block truncate text-[12px] text-[var(--site-muted)]">
            防治：{item.targetWeeds}
          </span>
        </span>
        <ArrowRight className="mt-2 size-4 shrink-0 text-[var(--site-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
}

function WeedRow({
  item,
  active,
  onSelect,
}: {
  item: AtlasWeed;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
          active ? "bg-[var(--gy-green-soft)]" : "hover:bg-[var(--gy-cream)]",
        )}
      >
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
          <Sprout className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold">{item.name}</span>
          <span className="mt-1 line-clamp-2 block text-[12px] leading-5 text-[var(--site-muted)]">
            {item.identifyKey}
          </span>
        </span>
        <ArrowRight className="mt-2 size-4 shrink-0 text-[var(--site-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
}

function RecordRow({
  item,
  active,
  onSelect,
}: {
  item: AtlasRecord;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
          active ? "bg-[var(--gy-green-soft)]" : "hover:bg-[var(--gy-cream)]",
        )}
      >
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-amber-soft)] text-[var(--gy-amber)]">
          <BookOpen className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold">{item.name}</span>
            <span className="gy-pill gy-pill--plain min-h-[24px] px-2 text-[11px]">
              部分字段
            </span>
          </span>
          <span className="mt-1 block text-[12px] text-[var(--site-muted)]">
            {item.registrationNumber} · {item.producer}
          </span>
          <span className="mt-1 block truncate text-[12px] text-[var(--site-muted)]">
            {item.useScene} · {item.target}
          </span>
        </span>
        <ArrowRight className="mt-2 size-4 shrink-0 text-[var(--site-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
}

function TimingRow({
  item,
  active,
  onSelect,
}: {
  item: ControlTimingEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
          active ? "bg-[var(--gy-green-soft)]" : "hover:bg-[var(--gy-cream)]",
        )}
      >
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
          <CalendarClock className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold">{item.crop}</span>
          <span className="mt-1 block text-[12px] text-[var(--site-muted)]">
            关键期：{item.window}
          </span>
          <span className="mt-1 block truncate text-[12px] text-[var(--site-muted)]">
            主要对象：{item.weeds}
          </span>
        </span>
        <ArrowRight className="mt-2 size-4 shrink-0 text-[var(--site-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
}

function ProvinceRow({
  item,
  active,
  onSelect,
}: {
  item: ProvinceEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
          active ? "bg-[var(--gy-green-soft)]" : "hover:bg-[var(--gy-cream)]",
        )}
      >
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-amber-soft)] text-[var(--gy-amber)]">
          <MapPin className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold">{item.province}</span>
            <span className="gy-pill gy-pill--plain min-h-[24px] px-2 text-[11px]">
              {item.region}
            </span>
          </span>
          <span className="mt-1 block text-[12px] text-[var(--site-muted)]">
            常见杂草 {item.count} 种 · {item.crops}
          </span>
        </span>
        <ArrowRight className="mt-2 size-4 shrink-0 text-[var(--site-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
}

function DetailHeading({
  kicker,
  title,
  pill,
}: {
  kicker: string;
  title: string;
  pill?: string;
}) {
  return (
    <div>
      <span className="gy-kicker">{kicker}</span>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[24px] font-bold leading-tight">{title}</h2>
        {pill && <span className="gy-pill gy-pill--amber text-[11px]">{pill}</span>}
      </div>
    </div>
  );
}

function HerbicideDetail({ item }: { item: AtlasHerbicide }) {
  return (
    <div className="gy-card p-5 sm:p-6">
      <DetailHeading kicker="除草剂" title={item.name} />
      <div className="mt-3 flex flex-wrap gap-2">
        <span className={cn("gy-pill", hazardTone(item.hazardLevel))}>
          风险等级 · {item.hazardLevel}
        </span>
        <span className="gy-pill gy-pill--plain">非用药依据</span>
      </div>
      <div className="mt-5 space-y-4 text-[14px] leading-7">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            别名
          </h3>
          <p className="mt-1">{item.aliases}</p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            风险说明
          </h3>
          <p className="mt-1">{item.hazardDetail}</p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            防治对象
          </h3>
          <p className="mt-1">{item.targetWeeds}</p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            登记与禁限用
          </h3>
          <p className="mt-1">{item.regions}</p>
        </div>
      </div>
      <p className="mt-5 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]">
        以上为种子整理稿，可能有遗漏或过期；禁限用以官方最新公告为准。本页不提供用量、稀释倍数或施用方法。
      </p>
      <FavoriteButton
        className="mt-3"
        kind="herbicide"
        itemKey={item.name}
        title={item.name}
        subtitle={`${item.aliases} · 风险：${item.hazardLevel} · 防治：${item.targetWeeds}`}
      />
      <Button
        asChild
        variant="outline"
        className="mt-4 min-h-[42px] w-full rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-4"
      >
        <Link to="/identify">
          去核对标签
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

function WeedDetail({ item }: { item: AtlasWeed }) {
  return (
    <div className="gy-card p-5 sm:p-6">
      <DetailHeading kicker="田间杂草" title={item.name} />
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="gy-pill">识别要点</span>
        <span className="gy-pill gy-pill--plain">以田间实物为准</span>
      </div>
      <p className="mt-4 whitespace-pre-line text-[14px] leading-7">{item.identifyKey}</p>
      <p className="mt-5 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]">
        苗期杂草与作物极像，单一特征不足以定性；不确定时先拍照、问当地农技人员，不要凭一张图决定用药。
      </p>
      <FavoriteButton
        className="mt-3"
        kind="weed"
        itemKey={item.name}
        title={item.name}
        subtitle={item.identifyKey}
      />
      <Button
        asChild
        variant="outline"
        className="mt-4 min-h-[42px] w-full rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-4"
      >
        <Link to="/identify">
          去核对标签
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

function TimingDetail({ item }: { item: ControlTimingEntry }) {
  return (
    <div className="gy-card p-5 sm:p-6">
      <DetailHeading kicker="防除时期" title={item.crop} pill="观察提示 · 非作业方案" />
      <div className="mt-4 space-y-4 text-[14px] leading-7">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            关键时期
          </h3>
          <p className="mt-1">{item.window}</p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            主要杂草对象
          </h3>
          <p className="mt-1">{item.weeds}</p>
        </div>
      </div>
      <p className="mt-5 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]">
        原稿还包含用量、稀释与具体作业描述，网页版未展示；上面的关键期是原稿摘录，仅用于理解田间的观察窗口，
        不构成作业方案。时期会随地域、天气和叶龄变化，请结合当地农技指导判断。
      </p>
      <Button
        asChild
        variant="outline"
        className="mt-4 min-h-[42px] w-full rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-4"
      >
        <Link to="/identify">
          去核对标签
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

function ProvinceDetail({ item }: { item: ProvinceEntry }) {
  return (
    <div className="gy-card p-5 sm:p-6">
      <DetailHeading kicker="省份索引" title={item.province} pill={item.region} />
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="gy-pill gy-pill--plain">常见杂草 {item.count} 种</span>
        <span className="gy-pill gy-pill--amber">种子整理稿</span>
      </div>
      <div className="mt-5 space-y-4 text-[14px] leading-7">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            常见杂草清单
          </h3>
          <p className="mt-1">{item.weeds}</p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--site-muted)]">
            主要作物
          </h3>
          <p className="mt-1">{item.crops}</p>
        </div>
      </div>
      <p className="mt-5 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]">
        清单为整理稿，未覆盖全部田间情况，也不代表当地发生程度。查到的名称只能用于对照识别，
        不能代替包装标签、官方登记和当地农技意见。
      </p>
      <Button
        asChild
        variant="outline"
        className="mt-4 min-h-[42px] w-full rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-4"
      >
        <Link to="/identify">
          去核对标签
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

const RECORD_FIELDS: { key: keyof AtlasRecord; label: string }[] = [
  { key: "registrationNumber", label: "登记证号" },
  { key: "name", label: "农药名称" },
  { key: "producer", label: "生产企业" },
  { key: "dosageForm", label: "剂型" },
  { key: "toxicity", label: "毒性" },
  { key: "pesticideClass", label: "类别" },
  { key: "ingredients", label: "有效成分" },
  { key: "useScene", label: "登记作物/场景" },
  { key: "target", label: "防治对象" },
  { key: "publisher", label: "来源" },
  { key: "issue", label: "公告" },
  { key: "publishedAt", label: "公告日期" },
];

const RECORD_STATUS_LABEL: Record<string, string> = {
  partial: "部分字段",
  complete: "字段完整",
};

const REVIEW_STATUS_LABEL: Record<string, string> = {
  unverified: "未核实",
  verified: "已核实",
};

function RecordDetail({ item }: { item: AtlasRecord }) {
  return (
    <div className="gy-card p-5 sm:p-6">
      <DetailHeading kicker="公开登记样本" title={item.name} pill="待核实 · 非权威" />
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="gy-pill gy-pill--plain">
          记录状态 · {RECORD_STATUS_LABEL[item.recordStatus] ?? item.recordStatus}
        </span>
        <span className="gy-pill gy-pill--amber">
          核对状态 · {REVIEW_STATUS_LABEL[item.reviewStatus] ?? item.reviewStatus}
        </span>
      </div>
      <dl className="mt-4 divide-y divide-[var(--site-border)] text-[13px]">
        {RECORD_FIELDS.map((field) => (
          <div key={field.key} className="grid grid-cols-[92px_1fr] gap-3 py-2.5">
            <dt className="text-[var(--site-muted)]">{field.label}</dt>
            <dd className="font-medium leading-6">{item[field.key]}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]">
        本轮未采集用药量、施用方法与禁限用状态，因此记录只覆盖部分字段。登记信息可能变更，
        请以中国农药信息网与包装标签为准；本页不构成用药依据。
      </p>
      <FavoriteButton
        className="mt-3"
        kind="record"
        itemKey={item.registrationNumber}
        title={item.name}
        subtitle={`${item.registrationNumber} · ${item.producer} · ${item.useScene}`}
      />
    </div>
  );
}
