import * as React from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  FileImage,
  Info,
  Loader2,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { addHistory, updateHistory } from "@/lib/store";
import { api, apiErrorText, uploadRecognitionFile, type RecognitionJob } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { Button } from "@/components/ui/button";
import { RiskVideo } from "@/components/risk-video";
import { Link } from "@/lib/router";
import { labelSample } from "@/lib/data";
import type { SampleRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "gy.labelCorrection.v1";

type Stage = "sample" | "scanning" | "result";

type IngredientDraft = {
  name: string;
  content_text: string;
  unit_text: string;
};

type CorrectionDraft = {
  registration_number: string;
  name: string;
  dosage_form: string;
  ingredients: IngredientDraft[];
};

type SavedNote = {
  kind: "blocked" | "saved";
  message: string;
  changes: string[];
};

const SCAN_STEPS = [
  { label: "作业已受理", detail: "queued" },
  { label: "正在读标签字段", detail: "running" },
  { label: "识别完成，等待人工核对", detail: "succeeded" },
];

const JOB_STATUS: Record<string, { label: string; tone: string }> = {
  uploaded: { label: "已上传，待提交", tone: "bg-[#f1f5ec] text-[#5f735a]" },
  needs_review: { label: "待人工复核", tone: "bg-[#fdf3df] text-[#8a7034]" },
  reviewed: { label: "已人工复核", tone: "bg-[#eff5e9] text-[#567441]" },
  failed: { label: "处理失败", tone: "bg-[#f7e9e5] text-[#8a4b3d]" },
};

function jobTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toDraft(record: SampleRecord): CorrectionDraft {
  return {
    registration_number: record.fields.registration_number ?? "",
    name: record.fields.name,
    dosage_form: record.fields.dosage_form,
    ingredients: record.fields.ingredients.map((item) => ({ ...item })),
  };
}

function formatIngredients(items: IngredientDraft[]) {
  return items
    .map((item) => `${item.name} ${item.content_text}${item.unit_text}`)
    .join("；");
}

function listChanges(record: SampleRecord, draft: CorrectionDraft) {
  const changes: string[] = [];
  const rawRegistration = record.fields.registration_number ?? "";
  if (draft.registration_number.trim() !== rawRegistration) {
    changes.push(
      `登记证号：「${rawRegistration || "未读出"}」→「${draft.registration_number.trim() || "留空"}」`,
    );
  }
  if (draft.name.trim() !== record.fields.name) {
    changes.push(`药名：「${record.fields.name}」→「${draft.name.trim()}」`);
  }
  if (draft.dosage_form.trim() !== record.fields.dosage_form) {
    changes.push(`剂型：「${record.fields.dosage_form}」→「${draft.dosage_form.trim()}」`);
  }
  const rawIngredients = formatIngredients(record.fields.ingredients);
  const draftIngredients = formatIngredients(draft.ingredients);
  if (draftIngredients !== rawIngredients) {
    changes.push(`有效成分：「${rawIngredients}」→「${draftIngredients || "留空"}」`);
  }
  return changes;
}

export function IdentifyPage() {
  const record = labelSample.record;
  const [stage, setStage] = React.useState<Stage>("sample");
  const [scanStep, setScanStep] = React.useState(0);
  const [draft, setDraft] = React.useState<CorrectionDraft>(() => toDraft(record));
  const [confirmed, setConfirmed] = React.useState(false);
  const [saved, setSaved] = React.useState<SavedNote | null>(null);
  const historyId = React.useRef<string | null>(null);
  const account = useAccount();
  const signedIn = Boolean(account.account);
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [uploadNotice, setUploadNotice] = React.useState("");
  const [uploadError, setUploadError] = React.useState("");
  const [jobs, setJobs] = React.useState<RecognitionJob[]>([]);
  const [modelConfigured, setModelConfigured] = React.useState(false);

  React.useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  React.useEffect(() => {
    if (!account.ready || !signedIn) {
      setJobs([]);
      return;
    }
    let active = true;
    api
      .recognitionJobs()
      .then((data) => {
        if (!active) return;
        setJobs(data.jobs);
        setModelConfigured(data.modelConfigured);
      })
      .catch(() => {
        if (active) setJobs([]);
      });
    return () => {
      active = false;
    };
  }, [account.ready, signedIn, account.account?.id]);

  React.useEffect(() => {
    if (stage !== "result" || historyId.current) return;
    const entry = addHistory({
      title: record.analysis.title,
      subtitle: `标签识别回放 · ${record.analysis.basisLabel} · 尚未人工更正`,
      corrections: [],
    });
    historyId.current = entry.id;
  }, [stage, record]);

  React.useEffect(() => {
    if (stage !== "scanning") return;
    const timers = [
      window.setTimeout(() => setScanStep(1), 800),
      window.setTimeout(() => setScanStep(2), 1800),
      window.setTimeout(() => setStage("result"), 3000),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [stage]);

  const changedNow = React.useMemo(() => listChanges(record, draft), [record, draft]);

  const reset = () => {
    setStage("sample");
    setScanStep(0);
    setDraft(toDraft(record));
    setConfirmed(false);
    setSaved(null);
    historyId.current = null;
    window.scrollTo(0, 0);
  };

  const startScan = () => {
    setScanStep(0);
    setSaved(null);
    historyId.current = null;
    setStage("scanning");
  };

  const updateIngredient = (index: number, key: keyof IngredientDraft, value: string) => {
    setDraft((current) => ({
      ...current,
      ingredients: current.ingredients.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    }));
  };

  const addIngredient = () => {
    setDraft((current) => ({
      ...current,
      ingredients: [...current.ingredients, { name: "", content_text: "", unit_text: "" }],
    }));
  };

  const removeIngredient = (index: number) => {
    setDraft((current) => ({
      ...current,
      ingredients: current.ingredients.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const pickFile = (next: File | null) => {
    setUploadNotice("");
    setUploadError("");
    if (!next) {
      setFile(null);
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(next.type)) {
      setUploadError("只支持 PNG、JPEG 或 WebP 图片。");
      setFile(null);
      return;
    }
    if (next.size > 5 * 1024 * 1024 || next.size === 0) {
      setUploadError("图片需小于 5MB，且不能是空文件。");
      setFile(null);
      return;
    }
    setFile(next);
  };

  const submitUpload = async () => {
    if (!file || uploading || !signedIn) return;
    setUploading(true);
    setUploadError("");
    setUploadNotice("");
    try {
      const result = await uploadRecognitionFile(file);
      setUploadNotice(
        result.note || "照片已进入人工复核队列。当前不会生成 AI 猜测结果。",
      );
      setFile(null);
      const data = await api.recognitionJobs();
      setJobs(data.jobs);
      setModelConfigured(data.modelConfigured);
    } catch (error) {
      setUploadError(apiErrorText(error));
    } finally {
      setUploading(false);
    }
  };

  const submitCorrection = () => {
    if (!confirmed) {
      setSaved({
        kind: "blocked",
        message: "请先勾选「我已对照农药包装实物逐项核对」。未勾选时不会保存任何内容。",
        changes: [],
      });
      return;
    }
    const changes = listChanges(record, draft);
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          fields: draft,
          changes,
        }),
      );
    } catch {
      setSaved({
        kind: "blocked",
        message: "浏览器不允许本机存储，本次更正没有保存；请检查隐私设置后重试。",
        changes: [],
      });
      return;
    }
    if (historyId.current) {
      updateHistory(historyId.current, {
        subtitle:
          changes.length > 0
            ? `标签识别回放 · 人工更正 ${changes.length} 项`
            : "标签识别回放 · 核对完成，未发现改动",
        corrections: changes,
      });
    } else {
      historyId.current = addHistory({
        title: record.analysis.title,
        subtitle:
          changes.length > 0
            ? `标签识别回放 · 人工更正 ${changes.length} 项`
            : "标签识别回放 · 核对完成，未发现改动",
        corrections: changes,
      }).id;
    }
    setSaved({
      kind: "saved",
      message:
        changes.length > 0
          ? `已记录 ${changes.length} 项更正，并写入探索记录。${signedIn ? "登录状态下会同步到云端账号。" : "当前未登录，只保存在本机。"}`
          : `已记录本次核对：未发现改动，并写入探索记录。${signedIn ? "登录状态下会同步到云端账号。" : "当前未登录，只保存在本机。"}`,
      changes,
    });
  };

  return (
    <div className="gy-shell">
      <header className="max-w-[62ch]">
        <span className="gy-kicker">标签核对 · LABEL REVIEW</span>
        <h1 className="mt-2 text-[29px] font-[650] leading-tight tracking-[-1px]">
          看清标签，再谈怎么用。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          这是一次真实运行记录的回放：机器先读出标签，解析在前，逐字段读数在后；读错的由你对照包装自己改。
          你也可以上传自己的标签照片；当前没有接入自动识别模型，照片只会进入人工复核队列，不会生成猜测结果。
        </p>
      </header>

      <ol className="mt-8 flex flex-wrap gap-2 text-[13px]" aria-label="操作步骤">
        {[
          { key: "sample", label: "1 选择样本" },
          { key: "scanning", label: "2 读取标签" },
          { key: "result", label: "3 解析与人工核对" },
        ].map((item) => {
          const active = stage === item.key;
          const done =
            (item.key === "sample" && stage !== "sample") ||
            (item.key === "scanning" && stage === "result");
          return (
            <li
              key={item.key}
              aria-current={active ? "step" : undefined}
              className={cn(
                "gy-pill",
                active && "border-[var(--gy-green)] bg-[var(--gy-green)] text-white",
                done && !active && "border-[var(--gy-green)]/30 text-[var(--gy-green)]",
                !active && !done && "gy-pill--plain",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden="true" /> : null}
              {item.label}
            </li>
          );
        })}
      </ol>

      {stage === "sample" && (
        <section className="gy-split mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div className="gy-card overflow-hidden p-3">
            <div className="relative overflow-hidden rounded-[calc(var(--site-radius)-4px)] bg-[#e8ece5]">
              <img
                src="/media/label-benzyl-propiconazole.jpg"
                alt="农药包装标签照片样本"
                className="aspect-[4/3] w-full object-cover"
              />
              <span className="gy-pill absolute left-3 top-3">真实拍摄样本</span>
            </div>
          </div>
          <div className="gy-card flex flex-col p-6">
            <span className="gy-pill w-fit">样本 01 · 农药标签</span>
            <h2 className="mt-4 text-[24px] font-bold leading-tight">
              {record.analysis.title}
            </h2>
            <p className="mt-3 text-[15px] leading-7 text-[var(--site-muted)]">
              {record.analysis.summary}
            </p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-[13px]">
              <div className="rounded-[10px] bg-[var(--gy-green-soft)] p-3">
                <dt className="text-[var(--site-muted)]">识别方式</dt>
                <dd className="mt-1 font-semibold">真实运行记录回放</dd>
              </div>
              <div className="rounded-[10px] bg-[var(--gy-green-soft)] p-3">
                <dt className="text-[var(--site-muted)]">记录日期</dt>
                <dd className="mt-1 font-semibold">{labelSample.capturedAt}</dd>
              </div>
            </dl>
            <p className="mt-4 text-[12px] leading-6 text-[var(--site-muted)]">
              {labelSample.note}
            </p>
            <Button
              size="lg"
              className="mt-6 min-h-[48px] w-full rounded-full bg-[var(--gy-green)] text-[16px] font-semibold text-white hover:bg-[var(--gy-green-deep)]"
              onClick={startScan}
            >
              用这张样本开始
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            <p className="mt-3 text-center text-[12px] text-[var(--site-muted)]">
              不上传照片 · 不需要登录 · 结果仅用于演示
            </p>
          </div>
        </section>
      )}

      {stage === "scanning" && (
        <section className="gy-split mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div className="gy-card overflow-hidden p-3">
            <div className="relative overflow-hidden rounded-[calc(var(--site-radius)-4px)] bg-[#e8ece5]">
              <img
                src="/media/label-benzyl-propiconazole.jpg"
                alt="正在读取的标签样本"
                className="aspect-[4/3] w-full object-cover"
              />
              <div className="absolute inset-0 bg-[var(--gy-green)]/10" />
              <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-transparent via-[var(--gy-lime)]/80 to-transparent gy-scan" />
            </div>
          </div>
          <div className="gy-card p-6" aria-live="polite">
            <span className="gy-pill">
              <ScanLine className="size-3.5" aria-hidden="true" />
              正在处理
            </span>
            <h2 className="mt-4 text-[22px] font-bold">机器正在读标签</h2>
            <p className="mt-2 text-[14px] leading-7 text-[var(--site-muted)]">
              演示回放会依次展示作业状态；真实小程序使用同一套七类 JobState。
            </p>
            <ul className="mt-6 space-y-4">
              {SCAN_STEPS.map((step, index) => {
                const done = scanStep > index;
                const current = scanStep === index;
                return (
                  <li key={step.detail} className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border text-[12px]",
                        done && "border-[var(--gy-green)] bg-[var(--gy-green)] text-white",
                        current &&
                          "border-[var(--gy-green)] bg-[var(--gy-green-soft)] text-[var(--gy-green)]",
                        !done && !current && "border-[var(--site-border)] text-[var(--site-muted)]",
                      )}
                    >
                      {done ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : current ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <div>
                      <div className="text-[15px] font-semibold">{step.label}</div>
                      <div className="text-[12px] text-[var(--site-muted)]">{step.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-6 text-[12px] leading-6 text-[var(--site-muted)]">
              机器读数不是权威判读；识别完成后仍需对照包装逐项核对。
            </p>
          </div>
        </section>
      )}

      {stage === "result" && (
        <div className="mt-6 space-y-6">
          <section className="gy-card overflow-hidden">
            <div className="border-b border-[var(--site-border)] bg-[var(--gy-green-soft)]/60 px-5 py-4 sm:px-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="gy-pill border-[var(--gy-green)]/30 bg-white">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  识别完成 · 示例回放
                </span>
                <span className="gy-pill gy-pill--amber">机器读数 · 非权威判读</span>
                <Link
                  to="/history"
                  className="gy-pill gy-pill--plain transition hover:border-[#c9d6c4]"
                >
                  已加入探索记录
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <div className="gy-split grid gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_260px]">
              <div>
                <h2 className="text-[26px] font-bold leading-tight">
                  {record.analysis.title}
                </h2>
                <p className="mt-1 text-[12px] text-[var(--site-muted)]">
                  依据：{record.analysis.basisLabel}（未更正）
                </p>
                <p className="mt-4 text-[16px] leading-8">{record.analysis.summary}</p>
                <dl className="mt-5 divide-y divide-[var(--site-border)]">
                  {record.analysis.rows.map((row) => (
                    <div key={row.label} className="gy-field-row grid gap-1 py-3 sm:grid-cols-[110px_1fr] sm:gap-4">
                      <dt className="text-[13px] font-medium text-[var(--site-muted)]">
                        {row.label}
                      </dt>
                      <dd className="text-[15px] leading-7">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 rounded-[10px] bg-[var(--gy-amber-soft)] px-4 py-3 text-[13px] leading-6 text-[var(--gy-amber)]">
                  {record.analysis.boundaryNote}
                </p>
              </div>
              <div>
                <div className="overflow-hidden rounded-[calc(var(--site-radius)-4px)] border border-[var(--site-border)] bg-[#e8ece5]">
                  <img
                    src="/media/label-benzyl-propiconazole.jpg"
                    alt="农药包装标签照片样本"
                    className="aspect-[4/3] w-full object-cover"
                  />
                </div>
                <p className="mt-3 text-[12px] leading-6 text-[var(--site-muted)]">
                  对照这张包装实物逐项核对，不要只信机器读数。
                </p>
              </div>
            </div>
          </section>

          <section id="risk-video" className="gy-card scroll-mt-24 p-5 sm:p-6">
            <RiskVideo
              src="/media/pesticide-harm-10-20-years.mp4"
              poster="/media/pesticide-harm-10-20-years-poster.jpg"
              title="十年与二十年 · 风险情景"
              desc={`以「${record.analysis.title}」为例，推演长期、超量、单一用药下土地可能出现的变化。`}
              buttonLabel="观看 26 秒情景推演"
              note="情景推演视频：假设长期、超量、单一用药，非科学预测，也不代表按标签正常使用的结果；画面由 AI 生成，不构成用药建议。"
            />
          </section>

          <section className="gy-card p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[20px] font-bold">机器原样读数</h2>
              <span className="gy-pill gy-pill--plain">只读 · 原样保留</span>
            </div>
            <p className="mt-2 text-[13px] leading-6 text-[var(--site-muted)]">
              {record.readOnlyNote}
            </p>
            <dl className="mt-4 divide-y divide-[var(--site-border)]">
              {record.readRows
                .filter((row) => row.value !== "（未读出）")
                .map((row) => (
                  <div key={row.label} className="gy-field-row grid gap-1 py-3 sm:grid-cols-[120px_1fr] sm:gap-4">
                    <dt className="text-[13px] text-[var(--site-muted)]">{row.label}</dt>
                    <dd className="text-[15px] font-medium leading-7">{row.value}</dd>
                  </div>
                ))}
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="gy-pill gy-pill--plain">登记核对：{record.matchLabel}</span>
              {record.matchState !== "unavailable" && record.conflictLabels.length === 0 && (
                <span className="gy-pill gy-pill--plain">未发现登记冲突</span>
              )}
            </div>
          </section>

          <section className="gy-card p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[20px] font-bold">人工核对与更正</h2>
              <span className="gy-pill">只改读错的内容</span>
            </div>
            <p className="mt-2 text-[13px] leading-6 text-[var(--site-muted)]">
              {record.correctionNote}
            </p>

            <div className="gy-form-grid mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium">药名</span>
                <input
                  className="gy-input"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium">剂型</span>
                <input
                  className="gy-input"
                  value={draft.dosage_form}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, dosage_form: event.target.value }))
                  }
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-[13px] font-medium">
                  登记证号（未读出可留空）
                </span>
                <input
                  className="gy-input"
                  value={draft.registration_number}
                  placeholder="对照包装照录，不要猜测"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      registration_number: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">有效成分（照录包装数字）</span>
                <button
                  type="button"
                  className="min-h-[36px] text-[13px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
                  onClick={addIngredient}
                >
                  + 增加一条
                </button>
              </div>
              <div className="mt-2 space-y-3">
                {draft.ingredients.map((item, index) => (
                  <div
                    key={index}
                    className="gy-ingredient-row grid gap-2 rounded-[10px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-3 sm:grid-cols-[1.2fr_0.8fr_0.8fr_auto]"
                  >
                    <input
                      className="gy-input"
                      value={item.name}
                      placeholder="成分名称"
                      aria-label={`第 ${index + 1} 条成分名称`}
                      onChange={(event) => updateIngredient(index, "name", event.target.value)}
                    />
                    <input
                      className="gy-input"
                      value={item.content_text}
                      placeholder="含量"
                      aria-label={`第 ${index + 1} 条含量`}
                      onChange={(event) =>
                        updateIngredient(index, "content_text", event.target.value)
                      }
                    />
                    <input
                      className="gy-input"
                      value={item.unit_text}
                      placeholder="单位"
                      aria-label={`第 ${index + 1} 条单位`}
                      onChange={(event) =>
                        updateIngredient(index, "unit_text", event.target.value)
                      }
                    />
                    <button
                      type="button"
                      className="min-h-[44px] rounded-[8px] px-3 text-[13px] font-medium text-[var(--gy-danger)] hover:bg-[#f7e8e4]"
                      onClick={() => removeIngredient(index)}
                      disabled={draft.ingredients.length <= 1}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              role="checkbox"
              aria-checked={confirmed}
              onClick={() => setConfirmed((value) => !value)}
              className={cn(
                "mt-5 flex min-h-[52px] w-full items-start gap-3 rounded-[10px] border p-4 text-left",
                confirmed
                  ? "border-[var(--gy-green)] bg-[var(--gy-green-soft)]"
                  : "border-[var(--site-border)] bg-[var(--gy-cream)]",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border",
                  confirmed
                    ? "border-[var(--gy-green)] bg-[var(--gy-green)] text-white"
                    : "border-[var(--site-muted)] bg-white",
                )}
              >
                {confirmed ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
              <span className="text-[14px] leading-6">
                我已对照农药包装实物逐项核对
                <span className="block text-[12px] text-[var(--site-muted)]">
                  未勾选时，提交不会保存任何内容。
                </span>
              </span>
            </button>

            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                size="lg"
                className="min-h-[48px] rounded-full bg-[var(--gy-green)] px-6 text-[15px] font-semibold text-white hover:bg-[var(--gy-green-deep)]"
                onClick={submitCorrection}
              >
                <ClipboardCheck className="size-4" aria-hidden="true" />
                保存本次核对（仅本机）
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="min-h-[48px] rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-5 text-[15px]"
                onClick={() => {
                  setDraft(toDraft(record));
                  setConfirmed(false);
                  setSaved(null);
                }}
              >
                撤销改动
              </Button>
            </div>

            {changedNow.length > 0 && (
              <p className="mt-3 text-[12px] text-[var(--site-muted)]">
                当前有 {changedNow.length} 项与机器读数不同，保存前请再核对一次。
              </p>
            )}

            {saved && (
              <div
                role="status"
                className={cn(
                  "mt-4 rounded-[10px] border px-4 py-3 text-[13px] leading-6",
                  saved.kind === "saved"
                    ? "border-[var(--gy-green)]/30 bg-[var(--gy-green-soft)] text-[var(--gy-green-deep)]"
                    : "border-[#ead6ae] bg-[var(--gy-amber-soft)] text-[var(--gy-amber)]",
                )}
              >
                <p className="font-semibold">{saved.message}</p>
                {saved.changes.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {saved.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="gy-card border-[#ead6ae] bg-[var(--gy-amber-soft)] p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-[var(--gy-amber)]"
                aria-hidden="true"
              />
              <div>
                <h2 className="text-[17px] font-bold text-[var(--gy-amber)]">
                  用量：不可展示
                </h2>
                <p className="mt-1 text-[13px] leading-6 text-[#7c4a10]">
                  {record.doseBlockReason}
                </p>
              </div>
            </div>
          </section>

          <section className="gy-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div>
              <h2 className="text-[17px] font-semibold">继续查这瓶药之外的事</h2>
              <p className="mt-1 text-[13px] leading-6 text-[var(--site-muted)]">
                关联科普在公开演示中未接入；可以先到识草查药看真实种子数据（待核实 · 非权威）。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                asChild
                variant="outline"
                className="min-h-[44px] rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-5"
              >
                <Link to="/atlas">
                  去识草查药
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button
                variant="outline"
                className="min-h-[44px] rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-5"
                onClick={reset}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                重新看一遍
              </Button>
            </div>
          </section>

          <p className="flex items-start gap-2 text-[12px] leading-6 text-[var(--site-muted)]">
            <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />
            {record.authorityNote} 数据来源：{record.sourceVersion}；本页为演示回放，不构成用药依据。
          </p>
        </div>
      )}

      <section className="gy-card mt-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[20px] font-bold">
            <FileImage className="size-5 text-[var(--gy-green)]" aria-hidden="true" />
            上传标签照片 · 人工复核
          </h2>
          <span className="gy-pill gy-pill--plain">需云端账号 · 先审后回</span>
        </div>
        <p className="mt-2 max-w-[72ch] text-[13px] leading-6 text-[var(--site-muted)]">
          {modelConfigured
            ? "照片会先进入识别任务，再由人工复核；机器结果不作为最终结论。"
            : "当前没有接入自动识别模型：照片不会得到 AI 猜测结果，只会进入人工复核队列。复核完成后，这里会显示人工填写的摘要。"}
          无论哪种情况，都不会提供用量、配比、药效承诺或施用方案。
        </p>

        {!signedIn ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[#f7f9f4] p-4">
            <p className="max-w-[52ch] text-[12px] leading-6 text-[var(--site-muted)]">
              上传需要云端账号，便于把复核结果送达你，并在注销时一并删除照片。
              上方样本回放仍然不需要登录。
            </p>
            <Link
              to="/profile"
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-4 text-[12px] font-semibold text-white"
            >
              去创建或恢复账号
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <label htmlFor="label-upload" className="mb-2 block text-[12px] font-medium">
                  选择包装标签照片（PNG / JPEG / WebP，≤ 5MB）
                </label>
                <input
                  id="label-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                  className="block w-full cursor-pointer rounded-[10px] border border-[var(--site-border)] bg-white p-2 text-[11px] text-[var(--site-muted)] file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-[var(--gy-green-soft)] file:px-4 file:py-2 file:text-[11px] file:font-medium file:text-[#315534]"
                />
                <p className="mt-2 text-[10px] leading-5 text-[var(--site-muted)]">
                  请先遮住人脸、车牌、门牌等与核对无关的信息；照片会保存在站点存储中，仅用于本次人工复核。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!file || uploading}
                    onClick={submitUpload}
                    className="inline-flex min-h-[42px] items-center gap-1.5 rounded-full bg-[var(--gy-green)] px-5 text-[12px] font-semibold text-white hover:bg-[var(--gy-green-deep)] disabled:opacity-50"
                  >
                    {uploading ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Upload className="size-3.5" aria-hidden="true" />
                    )}
                    {uploading ? "正在上传…" : "提交人工复核"}
                  </button>
                  {file && (
                    <button
                      type="button"
                      onClick={() => pickFile(null)}
                      className="min-h-[42px] rounded-full px-3 text-[11px] text-[var(--site-muted)] underline underline-offset-4"
                    >
                      取消选择
                    </button>
                  )}
                  {file && (
                    <span className="min-w-0 truncate text-[10px] text-[var(--site-muted)]">
                      {file.name} · {(file.size / 1024).toFixed(0)} KB
                    </span>
                  )}
                </div>
              </div>
              <div className="overflow-hidden rounded-[12px] border border-[var(--site-border)] bg-[#e8ece5]">
                {preview ? (
                  <img src={preview} alt="待提交的标签照片预览" className="aspect-[4/3] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 text-[#7f9183]">
                    <FileImage className="size-8" aria-hidden="true" />
                    <span className="text-[11px] tracking-[1.2px]">PHOTO PREVIEW</span>
                  </div>
                )}
              </div>
            </div>

            {uploadNotice && (
              <p
                role="status"
                className="mt-4 rounded-[10px] border border-[var(--gy-green)]/30 bg-[var(--gy-green-soft)] px-4 py-3 text-[12px] leading-6 text-[var(--gy-green-deep)]"
              >
                {uploadNotice}
              </p>
            )}
            {uploadError && (
              <p
                role="alert"
                className="mt-4 rounded-[10px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] px-4 py-3 text-[12px] leading-6 text-[#7c4a10]"
              >
                {uploadError}
              </p>
            )}

            <div className="mt-5 border-t border-[var(--site-border)] pt-4">
              <h3 className="text-[14px] font-semibold">我的提交</h3>
              {jobs.length === 0 ? (
                <p className="mt-2 text-[11px] text-[var(--site-muted)]">
                  还没有提交过照片。上传后会在这里显示复核状态。
                </p>
              ) : (
                <ul className="mt-3 grid gap-2.5">
                  {jobs.slice(0, 5).map((job) => {
                    const status = JOB_STATUS[job.status] ?? {
                      label: job.status,
                      tone: "bg-[#f1f5ec] text-[#5f735a]",
                    };
                    return (
                      <li
                        key={job.id}
                        className="rounded-[10px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-[4px] px-1.5 py-[2px] text-[9px]", status.tone)}>
                            {status.label}
                          </span>
                          <span className="text-[10px] text-[var(--site-muted)]">
                            提交于 {jobTime(job.createdAt)}
                          </span>
                        </div>
                        {job.note && (
                          <p className="mt-2 text-[11px] leading-5 text-[var(--site-muted)]">{job.note}</p>
                        )}
                        {job.status === "reviewed" && (
                          <div className="mt-2 rounded-[8px] bg-white px-3 py-2">
                            <strong className="text-[10px] font-semibold text-[#315534]">
                              人工复核摘要（非 AI 结果）
                            </strong>
                            <p className="mt-1 text-[11px] leading-5 text-[#4b5d52]">
                              {job.correctedSummary || "复核已完成，未填写摘要。请以包装标签为准。"}
                            </p>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <div className="mt-8 flex items-start gap-2 rounded-[10px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-4 text-[12px] leading-6 text-[var(--site-muted)]">
        <TriangleAlert className="mt-1 size-4 shrink-0 text-[var(--gy-amber)]" aria-hidden="true" />
        <p>
          本页所有识别结果均为机器读数，不是权威判读；人工更正只代表本次核对，不代表识别准确。登记信息以官方登记和包装标签为准。
        </p>
      </div>
    </div>
  );
}
