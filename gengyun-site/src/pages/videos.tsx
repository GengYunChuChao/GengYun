import { RiskVideo } from "@/components/risk-video";
import { Link } from "@/lib/router";
import { ArrowRight } from "lucide-react";

export function VideosPage() {
  return (
    <div>
      <header className="max-w-[68ch]">
        <span className="gy-kicker">情景视频 · SCENARIO</span>
        <h1 className="mt-2 text-[24px] font-[650] leading-tight tracking-[-0.8px] sm:text-[29px] sm:tracking-[-1px]">
          看见时间里的想象
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          用两段视频，补充标签照片之外的时间与过程。
        </p>
      </header>

      <div className="gy-split mt-6 grid gap-[22px] lg:grid-cols-2">
        <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <RiskVideo
            src="/media/pesticide-harm-10-20-years.mp4"
            poster="/media/pesticide-harm-10-20-years-poster.jpg"
            title="十年与二十年 · 风险情景"
            desc="同一块田长期、超量、单一用药，土地可能出现的变化。"
            buttonLabel="观看 26 秒情景推演"
            note="情景推演视频：假设长期、超量、单一用药，非科学预测，也不代表按标签正常使用的结果；画面由 AI 生成，不构成用药建议。"
          />
        </section>

        <section className="rounded-[16px] border border-[var(--site-border)] bg-white p-[23px]">
          <RiskVideo
            src="/media/label-ocr-demo.mp4"
            poster="/media/label-ocr-demo-poster.jpg"
            title="真实运行回放 · 标签识别"
            desc="从拍摄标签到逐项核对，记录本项目的一次真实运行过程。"
            buttonLabel="观看运行回放"
            note="真实运行录屏回放：识别字典为项目演示数据，不是官方农药登记库；结果以包装标签原文为准，不提供用量与施用方法。"
          />
        </section>
      </div>

      <section className="mt-5 rounded-[16px] border border-[var(--site-border)] bg-[#f7f9f4] p-[23px]">
        <h2 className="text-[14px] font-[650]">观看之前</h2>
        <p className="mt-2 max-w-[80ch] text-[11px] leading-[1.9] text-[var(--site-muted)]">
          视频用于呈现观察与情景，不替代标签、登记信息或当地农技指导。若要核对具体产品，请回到
          <Link to="/identify" className="mx-1 font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]">
            识别页
          </Link>
          逐项核对包装原文。
        </p>
        <Link
          to="/identify"
          className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--gy-green)] hover:text-[var(--gy-green-deep)]"
        >
          去识别一张标签
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </section>
    </div>
  );
}