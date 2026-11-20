import * as React from "react";
import { ArrowRight, Info, Send, Sprout, Volume2, VolumeX } from "lucide-react";
import { Link } from "@/lib/router";
import { getPreferences, setPreferences, useStoreVersion } from "@/lib/store";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  "水稻叶片发黄，先看什么？",
  "拍杂草时，怎样让叶鞘更清楚？",
  "标签上的登记证号在哪里看？",
];

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const INITIAL_TURNS: Turn[] = [
  { id: "t1", role: "user", text: "水稻叶片发黄，先看什么？" },
  {
    id: "t2",
    role: "assistant",
    text:
      "先看是新叶还是老叶、是否成片，再记录天气与田间水层；拍照时带上整株和叶鞘。仅凭一张照片不能确认原因，建议带着记录咨询当地农技人员。",
  },
];

function localAnswer(question: string) {
  const q = question.replace(/\s+/g, "");
  if (/用量|打多少|喷多少|稀释|配比|倍数|毫升|克每亩/.test(q)) {
    return "网页演示不提供用量、稀释倍数或混配方案。用量只应回到你手里这瓶药的包装标签和当地农技指导；登记信息可在资料库查看，但不能替代标签。";
  }
  if (/黄|枯|斑点|病|卷叶|倒伏|不长/.test(q)) {
    return "先判断是新叶还是老叶、整片还是零星，再记录出现时间、天气、水层或土壤湿度。把整株、叶片正反面和叶鞘拍清楚，带着这些记录咨询当地农技人员；单张照片不能定性，也不建议先用药。";
  }
  if (/草|杂草|识别|拍照|拍|叶鞘|稗|千金子/.test(q)) {
    return "拍杂草时先拍整株和周边作物，再补叶片、叶鞘、茎节和花序。稗草与水稻最容易混淆，可以重点看叶耳叶舌、叶片软硬和基部颜色。拿不准时先到资料库对照识别要点，再请当地农技人员确认。";
  }
  if (/标签|登记证|包装|成分|剂型|毒性/.test(q)) {
    return "标签上先找农药登记证号、有效成分与含量、剂型、毒性标识和登记作物。登记证号通常以「PD」或「LS」等开头，照录包装原文，不要猜测。可以到识别页用真实样本回放看一遍核对顺序。";
  }
  if (/什么时候|时期|季节|几月|温度|天气/.test(q)) {
    return "防除时期要结合作物生育期、杂草叶龄和当地天气判断，网页演示没有采集这些条件，不能给出统一时间。建议记录田间实际情况，并咨询当地农技部门发布的指导。";
  }
  return "可以先把观察拆成三件事：看到了什么现象、发生在哪类田块、持续了多久。再补整株与叶片的清晰照片，记录天气和水肥情况。需要判断草种时，可到资料库对照识别要点；需要核对农药时，回到包装标签。";
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.95;
  const voice = window.speechSynthesis
    .getVoices()
    .find((item) => /zh|Chinese/i.test(`${item.lang} ${item.name}`));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}

export function QaPage() {
  useStoreVersion();
  const preferences = getPreferences();
  const [turns, setTurns] = React.useState<Turn[]>(INITIAL_TURNS);
  const [question, setQuestion] = React.useState("");
  const [autoRead, setAutoRead] = React.useState(preferences.autoReadAnswers);
  const [notice, setNotice] = React.useState("");
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const ask = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const reply = localAnswer(trimmed);
    const assistantId = `a-${Date.now()}`;
    setTurns((current) => [
      ...current,
      { id: `q-${Date.now()}`, role: "user", text: trimmed },
      { id: assistantId, role: "assistant", text: reply },
    ]);
    setQuestion("");
    setNotice("");
    if (autoRead) {
      const ok = speak(reply);
      if (ok) setSpeakingId(assistantId);
      else setNotice("当前浏览器不支持语音播报，回答仍以文字显示。");
    }
  };

  const toggleAutoRead = () => {
    const next = !autoRead;
    setAutoRead(next);
    setPreferences({ autoReadAnswers: next });
    if (!next && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
    }
  };

  return (
    <div>
      <header className="max-w-[68ch]">
        <span className="gy-kicker">农事问答 · FIELD Q&amp;A</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          把问题说给耕云听
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          先描述观察到的现象，再一起找下一步该看什么。回答由本地规则生成，可朗读，不连接问答模型。
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="gy-pill gy-pill--plain">本地规则演示</span>
        <span className="gy-pill gy-pill--amber">不提供用量与配比</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoRead}
          onClick={toggleAutoRead}
          className="ml-auto inline-flex min-h-[36px] items-center gap-2 rounded-full border border-[var(--site-border)] bg-white px-3.5 text-[11px] text-[var(--site-fg)] transition hover:border-[#c9d6c4]"
        >
          {autoRead ? (
            <Volume2 className="size-3.5 text-[var(--gy-green)]" aria-hidden="true" />
          ) : (
            <VolumeX className="size-3.5 text-[var(--site-muted)]" aria-hidden="true" />
          )}
          自动朗读{autoRead ? "开" : "关"}
        </button>
        <button
          type="button"
          onClick={() => {
            setTurns(INITIAL_TURNS);
            setNotice("已回到初始示例对话。");
          }}
          className="inline-flex min-h-[36px] items-center rounded-full px-3 text-[11px] text-[var(--site-muted)] hover:text-[var(--site-fg)]"
        >
          重置对话
        </button>
      </div>

      <div className="gy-split mt-5 grid gap-[22px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[16px] font-[650]">对话</h2>
            <span className="gy-pill gy-pill--plain">{turns.length} 条消息</span>
          </div>

          <div className="mt-4 grid max-h-[460px] gap-3 overflow-y-auto pr-1 scrollbar-thin" aria-live="polite">
            {turns.map((turn) =>
              turn.role === "user" ? (
                <div
                  key={turn.id}
                  className="ml-auto max-w-[86%] rounded-[14px] rounded-br-[4px] bg-[var(--gy-green)] px-4 py-3 text-[12px] leading-[1.8] text-white"
                >
                  {turn.text}
                </div>
              ) : (
                <div key={turn.id} className="max-w-[94%]">
                  <div className="rounded-[14px] rounded-bl-[4px] bg-[#f2f5ef] px-4 py-3 text-[12px] leading-[1.9] text-[#3f5148]">
                    {turn.text}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const ok = speak(turn.text);
                      if (ok) {
                        setSpeakingId(turn.id);
                        setNotice("");
                      } else {
                        setNotice("当前浏览器不支持语音播报，回答仍以文字显示。");
                      }
                    }}
                    className={cn(
                      "mt-1 inline-flex min-h-[30px] items-center gap-1 rounded-full px-2 text-[10px] transition hover:bg-[#f7f9f4]",
                      speakingId === turn.id
                        ? "text-[var(--gy-green-deep)]"
                        : "text-[var(--site-muted)]",
                    )}
                  >
                    <Volume2 className="size-3" aria-hidden="true" />
                    {speakingId === turn.id ? "正在朗读" : "朗读回答"}
                  </button>
                </div>
              ),
            )}
          </div>

          <form
            className="mt-5 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor="qa-question" className="sr-only">
              你的田间问题
            </label>
            <input
              id="qa-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="写下你的田间问题…"
              maxLength={200}
              className="gy-input flex-1"
            />
            <button
              type="submit"
              className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-[var(--gy-green)] text-white transition hover:bg-[var(--gy-green-deep)]"
              aria-label="发送问题"
            >
              <Send className="size-4" aria-hidden="true" />
            </button>
          </form>
          {notice && (
            <p role="status" className="mt-2 text-[11px] text-[var(--site-muted)]">
              {notice}
            </p>
          )}
          <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-[1.8] text-[var(--site-muted)]">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            本地规则只做观察提示，不提供农药用量、配比或施用方法；用量只回到包装标签与当地农技指导。
          </p>
        </section>

        <aside className="grid content-start gap-[22px]">
          <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
            <h2 className="text-[16px] font-[650]">可以这样问</h2>
            <div className="mt-3 grid gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setQuestion(example);
                    ask(example);
                  }}
                  className="rounded-[10px] bg-[#f7f9f4] px-3 py-2.5 text-left text-[11px] leading-[1.7] text-[#5f735a] transition hover:bg-[#f1f5ec]"
                >
                  {example}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-5 text-[var(--site-muted)]">
              语音播报由浏览器提供，是否可用取决于系统和浏览器；不会上传录音。
            </p>
          </section>

          <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
            <h2 className="flex items-center gap-2 text-[16px] font-[650]">
              <Sprout className="size-4 text-[var(--gy-green)]" aria-hidden="true" />
              先把观察准备好
            </h2>
            <p className="mt-2 text-[11px] leading-[1.9] text-[var(--site-muted)]">
              一张照片不足以判断原因。整株、叶片、叶鞘和周边环境，都是有用的线索。
            </p>
            <div className="mt-3 grid gap-2">
              <Link
                to="/identify"
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
              >
                去识别标签
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
              <Link
                to="/atlas"
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
              >
                查田间资料
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}