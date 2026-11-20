import * as React from "react";
import {
  ArrowRight,
  Leaf,
  MessageSquareText,
  ScanLine,
  Settings2,
  Sun,
  Video,
  Wheat,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolCard } from "@/components/site-shell";
import { Link } from "@/lib/router";

const KNOWLEDGE = [
  {
    title: "稗草的叶片与叶鞘",
    desc: "从叶形、叶鞘与生长环境，建立田间观察记录。",
    tag: "杂草",
    icon: Leaf,
    tone: "green" as const,
  },
  {
    title: "读懂一张农药标签",
    desc: "先确认产品信息，再查看登记与适用范围。",
    tag: "标签",
    icon: ScanLine,
    tone: "blue" as const,
  },
  {
    title: "田间观察：从记录开始",
    desc: "将时间、地点与照片，变成连续的观察。",
    tag: "农事",
    icon: Wheat,
    tone: "amber" as const,
  },
];

const TIMELINE = [
  { title: "完成一次田间观察", desc: "拍照识草 · 09:20", to: "/identify" },
  { title: "读懂标签上的信息", desc: "标签资料 · 09:35", to: "/atlas" },
  { title: "看见二十年后的想象", desc: "情景视频 · 等待你探索", to: "/videos" },
];

const TAG_CLASS = {
  green: "gy-pill",
  blue: "gy-pill gy-pill--blue",
  amber: "gy-pill gy-pill--amber",
};

const GREETINGS = {
  morning: ["早安", "早上好", "清晨好"],
  noon: ["午安", "中午好", "午间好"],
  afternoon: ["下午好", "午后好"],
  evening: ["晚上好", "傍晚好", "晚间好"],
  night: ["夜深了", "晚安"],
};

type GreetingSlot = keyof typeof GREETINGS;

function greetingSlot(hour: number): GreetingSlot {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function pickGreeting(date: Date) {
  const slot = greetingSlot(date.getHours());
  const options = GREETINGS[slot];
  return { slot, text: options[Math.floor(Math.random() * options.length)] };
}

function useGreeting() {
  const [greeting, setGreeting] = React.useState(() => pickGreeting(new Date()));

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setGreeting((current) => {
        const next = pickGreeting(new Date());
        return next.slot === current.slot ? current : next;
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return greeting.text;
}

export function HomePage() {
  const greeting = useGreeting();

  return (
    <div>
      <div className="gy-page-heading mb-6 flex items-center justify-between gap-[15px]">
        <div className="min-w-0">
          <h1 className="text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
            {greeting}，田间探索者
          </h1>
          <p className="mt-[9px] text-[12px] leading-[1.7] text-[var(--site-muted)]">
            从一次观察开始，发现更多田间可能。
          </p>
        </div>
        <span className="flex h-9 shrink-0 items-center gap-[7px] rounded-full border border-[#e0e7dc] bg-[#fafbf8] px-[13px] text-[12px] text-[#64755f]">
          <Wheat className="size-[15px]" aria-hidden="true" />
          水稻
          <Settings2 className="size-[15px]" aria-hidden="true" />
        </span>
      </div>

      <section className="gy-hero relative flex min-h-[278px] items-center overflow-hidden rounded-[22px] bg-[#123e31] px-6 py-7 text-white sm:px-[38px] sm:py-[35px] lg:h-[278px]">
        <img
          src="/media/hero-field.svg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 h-full w-[74%] object-cover object-right opacity-95 sm:w-[58%]"
        />
        <div className="gy-hero-content relative z-[1] w-[88%] sm:w-[62%]">
          <div className="flex items-center gap-2 text-[9px] tracking-[2px] text-[#b5d8bd]">
            <span className="size-1.5 rounded-full bg-[var(--gy-lime)]" aria-hidden="true" />
            FIELD INTELLIGENCE / 耕云
          </div>
          <h2 className="mb-[11px] mt-[17px] text-[28px] font-medium leading-[1.48] tracking-[1px] sm:text-[34px]">
            看见田间的
            <br />
            每一种可能。
          </h2>
          <p className="text-[12px] leading-[1.8] text-[#accec0]">
            识别一株草，读懂一张标签。
            <br />
            让每一个田间问题，都有探索的起点。
          </p>
          <Button
            asChild
            className="mt-[22px] h-10 rounded-[10px] bg-[var(--gy-lime)] px-[18px] text-[13px] font-[550] text-[#264630] hover:bg-[#d3f495]"
          >
            <Link to="/identify">
              开始识别
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <span className="absolute bottom-[21px] right-[25px] hidden text-[9px] tracking-[2px] text-[#83b499] sm:block">
          OBSERVE · UNDERSTAND · EXPLORE
        </span>
      </section>

      <section className="mt-[27px]">
        <div className="mb-4 flex items-center justify-between gap-2.5">
          <h2 className="text-[17px] font-[650]">你的田间工具</h2>
          <span className="text-[10px] text-[#a2b28c]">四个入口，一个探索旅程</span>
        </div>
        <div className="gy-tools grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <ToolCard
            to="/identify"
            icon={Leaf}
            title="拍照识草"
            desc="留住田间的新发现"
          />
          <ToolCard
            to="/identify"
            icon={ScanLine}
            title="扫描标签"
            desc="让复杂信息更清晰"
            tone="teal"
          />
          <ToolCard
            to="/qa"
            icon={MessageSquareText}
            title="农事问答"
            desc="把问题说给耕云听"
            tone="amber"
          />
          <ToolCard
            to="/videos"
            icon={Video}
            title="情景视频"
            desc="看见时间里的想象"
            tone="violet"
            badge="NEW"
          />
        </div>
      </section>

      <div className="gy-home-bottom mt-[27px] grid gap-[22px] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <div className="mb-[18px] flex items-center justify-between gap-3">
            <h2 className="text-[16px] font-[650]">田间知识，一点点积累</h2>
            <Link
              to="/atlas"
              className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--site-muted)] transition hover:text-[var(--gy-green)]"
            >
              查看资料库
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          </div>
          <ul>
            {KNOWLEDGE.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.title}>
                  <Link
                    to="/atlas"
                    className="flex items-center gap-3 border-b border-[#eff3ec] py-3 transition-colors last:border-0 hover:bg-[#f7f9f4]"
                  >
                    <span
                      className={
                        item.tone === "blue"
                          ? "grid h-[50px] w-[58px] shrink-0 place-items-center overflow-hidden rounded-[9px] bg-[#edf4f4] text-[#638184]"
                          : item.tone === "amber"
                            ? "grid h-[50px] w-[58px] shrink-0 place-items-center overflow-hidden rounded-[9px] bg-[#f7f1e3] text-[#987d4b]"
                            : "grid h-[50px] w-[58px] shrink-0 place-items-center overflow-hidden rounded-[9px] bg-[#e9f0df] text-[#68815c]"
                      }
                    >
                      <Icon className="size-6" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-[13px] font-semibold leading-[1.6]">
                        {item.title}
                      </strong>
                      <small className="mt-1 block truncate text-[11px] leading-[1.7] text-[#9da79c]">
                        {item.desc}
                      </small>
                    </span>
                    <span className={`${TAG_CLASS[item.tone]} shrink-0`}>{item.tag}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            演示资料 · 不提供用量与施用建议，登记信息以包装标签为准。
          </p>
        </section>

        <section className="flex min-w-0 flex-col rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <div className="mb-[18px] flex items-center justify-between gap-3">
            <h2 className="text-[16px] font-[650]">今天的探索</h2>
            <span className="gy-pill gy-pill--plain shrink-0">示例记录</span>
          </div>
          <div className="grid gap-[21px] pl-[5px]">
            {TIMELINE.map((item, index) => (
              <Link key={item.title} to={item.to} className="group relative flex items-start gap-[13px]">
                {index < TIMELINE.length - 1 && (
                  <span
                    className="absolute left-[7px] top-[16px] h-[calc(100%+15px)] w-px bg-[#e2e9dc]"
                    aria-hidden="true"
                  />
                )}
                <span
                  className="relative z-[1] mt-[3px] size-[15px] shrink-0 rounded-full border-4 border-[#edf3e7] bg-[#7e9d69]"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <strong className="block text-[12px] font-semibold leading-[1.7] group-hover:text-[var(--gy-green)]">
                    {item.title}
                  </strong>
                  <small className="mt-1 block text-[10px] text-[#9ca797]">{item.desc}</small>
                </span>
              </Link>
            ))}
          </div>
          <div className="mt-auto flex items-center gap-1.5 pt-5 text-[10px] text-[#adb6aa]">
            <Sun className="size-3" aria-hidden="true" />
            本页为示例记录，不保存到云端
          </div>
        </section>
      </div>
    </div>
  );
}