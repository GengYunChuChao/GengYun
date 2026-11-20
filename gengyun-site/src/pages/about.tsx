import {
  ArrowRight,
  ClipboardCheck,
  Code2,
  Eye,
  HeartHandshake,
  ShieldCheck,
  Sprout,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RiskVideo } from "@/components/risk-video";
import { Link } from "@/lib/router";

const TEAM = [
  {
    role: "成员 A",
    duty: "产品与内容",
    detail: "场景取舍、页面文案、核对口径与免责声明。",
  },
  {
    role: "成员 B",
    duty: "前端与交互",
    detail: "小程序 / Web、适老化与无障碍、视频呈现。",
  },
  {
    role: "成员 C",
    duty: "数据与质量",
    detail: "真实样本、接口契约、验收清单与过程留证。",
  },
];

const QODER_STEPS = [
  "读现有小程序与接口文档，梳理可迁移范围；",
  "产出迁移计划、页面结构与数据清单；",
  "完成站点脚手架、页面实现与真实样本接入；",
  "用内置浏览器逐页验证主流程、移动端与视频播放；",
  "通过 Qoder Sites 部署并设置公开访问。",
];

const BOUNDARIES = [
  "样本回放不连接识别服务；自行上传的标签照片没有自动识别模型，只会进入人工复核队列，页面不会生成猜测结果。",
  "云端账号是可选项：只用恢复码登录，不收集手机号或邮箱；社区内容先审后发，照片仅用于本次人工复核。",
  "站点农药与科普条目为演示数据，不是官方农药登记库；登记以包装和官方查询为准。",
  "十年 / 二十年视频是情景推演，不是科学预测；画面由 AI 生成，不构成用药建议。",
  "任何页面都不显示用量、配比或施用方法；用量只回到标签与当地农技指导。",
];

export function AboutPage() {
  return (
    <div className="gy-shell">
      <header className="max-w-[68ch]">
        <span className="gy-kicker">关于耕云 · ABOUT</span>
        <h1 className="mt-2 text-[29px] font-[650] leading-tight tracking-[-1px]">
          让农业 AI 少一点替你做主，多一点帮你看清。
        </h1>
        <p className="mt-2 text-[12px] leading-[1.9] text-[var(--site-muted)]">
          耕云是一款面向种植户的「识草查药 + 安全用药核对」工具：先解析这瓶药，再把机器读数交还给人工核对，
          永远不替你决定用量。
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <span className="gy-pill">2026 Qoder 高校创造力大赛</span>
          <span className="gy-pill gy-pill--amber">Hack4Good · 技术向善</span>
          <span className="gy-pill gy-pill--plain">3 人团队</span>
        </div>
      </header>

      <section className="gy-split mt-10 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <h2 className="text-[24px] font-bold">为什么做这件事</h2>
          <div className="gy-prose mt-4 text-[15px] leading-8">
            <p>
              这个项目源于一个很具体的问题：农药标签，普通种植户很难真正看懂。字小、术语多，
              有效成分、剂型、登记证号挤在一起；忙起来的时候，很少有人能把一整张标签读完。
            </p>
            <p>
              市面上的识别工具又常常直接给一个结论，甚至顺手给出用量。可一旦读错，使用者很难发现，
              后果却要由这块田来承担。
            </p>
            <p>
              还有两个被忽略的缺口：单次识别回答不了「同一块田长期、超量、单一用药，十年后会怎样」；
              字号小、步骤多、按钮密，家里长辈往往在第一步就放弃。
            </p>
          </div>

          <div className="mt-6 space-y-3">
            {[
              {
                icon: Eye,
                title: "机器先把标签读出来",
                text: "识别是读数，不是判读；结果原样摊开，不替人下结论。",
              },
              {
                icon: ClipboardCheck,
                title: "人对照包装，逐项核对",
                text: "读错的字段可以改，改过的行保留机器原始读数。",
              },
              {
                icon: ShieldCheck,
                title: "用量回到标签和农技指导",
                text: "工具不显示用量，不用一个看似精确的数字制造安全感。",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="flex items-start gap-3 rounded-[12px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-4"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--gy-green-soft)] text-[var(--gy-green)]">
                  <item.icon className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold">{item.title}</h3>
                  <p className="mt-1 text-[13px] leading-6 text-[var(--site-muted)]">{item.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="gy-card h-fit p-6">
          <span className="grid size-11 place-items-center rounded-full bg-[var(--gy-green)] text-white">
            <Sprout className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-[22px] font-bold">「耕云」是什么意思</h2>
          <p className="mt-3 text-[14px] leading-7 text-[var(--site-muted)]">
            取的是把田里的经验变成看得见的依据：耕耘在地里，判断有据可依。
            我们不想做又一个「拍照出答案」的工具，而是把顺序摆正——机器读数、人工核对、再谈怎么管。
          </p>
          <div className="my-5 h-px bg-[var(--site-border)]" />
          <p className="text-[13px] leading-7">
            <strong className="font-semibold">一句话：</strong>
            先看清这瓶药，再决定怎么打。
          </p>
          <Button
            asChild
            className="mt-5 min-h-[44px] w-full rounded-full bg-[var(--gy-green)] px-5 text-white hover:bg-[var(--gy-green-deep)]"
          >
            <Link to="/identify">
              看一次真实核对
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </aside>
      </section>

      <section className="mt-12">
        <div className="flex items-center gap-2">
          <Users className="size-5 text-[var(--gy-green)]" aria-hidden="true" />
          <h2 className="text-[24px] font-bold">三个人的小队</h2>
        </div>
        <p className="mt-2 max-w-[70ch] text-[14px] leading-7 text-[var(--site-muted)]">
          因为同一件事走到一起：让农业 AI 少一点替你做主，多一点帮你看清。
        </p>
        <div className="gy-stack mt-5 grid gap-4 sm:grid-cols-3">
          {TEAM.map((member) => (
            <div key={member.role} className="gy-card p-5">
              <span className="gy-pill">{member.role}</span>
              <h3 className="mt-3 text-[17px] font-semibold">{member.duty}</h3>
              <p className="mt-2 text-[13px] leading-6 text-[var(--site-muted)]">{member.detail}</p>
              <p className="mt-4 text-[12px] text-[var(--site-muted)]">姓名 / 学校：待补</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-[12px] border border-[var(--site-border)] bg-[var(--gy-cream)] p-4">
          <HeartHandshake className="mt-0.5 size-5 shrink-0 text-[var(--gy-green)]" aria-hidden="true" />
          <p className="text-[13px] leading-6 text-[var(--site-muted)]">
            共同约定：不夸大 AI 的能力，机器读数一律标注「非权威判读」；不伪造数据、不编登记证号、
            不展示任何用量数字；每一个结论都要能被复述、被核对、被推翻。
          </p>
        </div>
      </section>

      <section className="mt-12">
        <div className="flex items-center gap-2">
          <Code2 className="size-5 text-[var(--gy-green)]" aria-hidden="true" />
          <h2 className="text-[24px] font-bold">这个站点怎么用 Qoder 做出来</h2>
        </div>
        <p className="mt-2 max-w-[70ch] text-[14px] leading-7 text-[var(--site-muted)]">
          需求拆解、方案设计、代码实现、浏览器验证与公网发布都在 Qoder 中完成；关键步骤保留截图，
          作为参赛过程材料。
        </p>
        <ol className="gy-stack mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {QODER_STEPS.map((step, index) => (
            <li key={step} className="gy-card p-4">
              <span className="text-[12px] font-bold text-[var(--gy-green)]">
                0{index + 1}
              </span>
              <p className="mt-2 text-[13px] leading-6">{step}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-[var(--site-muted)]">
          站点维护：
          <Link to="/moderation" className="font-semibold text-[var(--gy-green)] underline underline-offset-4">
            社区审核与照片复核入口
          </Link>
          ，需要管理码。
        </p>
      </section>

      <section className="gy-split mt-12 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
        <div>
          <h2 className="text-[24px] font-bold">真实运行录屏</h2>
          <p className="mt-3 text-[14px] leading-7 text-[var(--site-muted)]">
            这段录屏来自本项目小程序端的真实运行：导入标签照片、等待识别、先看解析，再逐项人工核对。
            公网站点不复刻自动识别过程，只回放这次记录，以便任何人都能查看同一份结果；
            另提供登录后上传照片的人工复核入口，不会生成猜测结果。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="gy-pill">真实运行记录</span>
            <span className="gy-pill gy-pill--plain">演示数据</span>
            <span className="gy-pill gy-pill--plain">无剪辑特效</span>
          </div>
        </div>
        <div className="gy-card p-5 sm:p-6">
          <RiskVideo
            src="/media/label-ocr-demo.mp4"
            poster="/media/label-ocr-demo-poster.jpg"
            title="标签核对 · 真实运行录屏"
            desc="从导入照片到解析、读数与人工更正，完整走一遍核对路径。"
            buttonLabel="播放 48 秒录屏"
            note="录屏使用演示数据，不包含真实农户信息；界面中的登记信息以包装和官方查询为准。"
          />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-[24px] font-bold">诚实边界</h2>
        <ul className="gy-stack mt-4 grid gap-3 sm:grid-cols-2">
          {BOUNDARIES.map((item) => (
            <li
              key={item}
              className="flex items-start gap-3 rounded-[12px] border border-[#ead6ae] bg-[var(--gy-amber-soft)] p-4 text-[13px] leading-6 text-[#7c4a10]"
            >
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12 gy-card flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[19px] font-bold">先看清这瓶药，再决定怎么打。</h2>
          <p className="mt-1 text-[13px] leading-6 text-[var(--site-muted)]">
            从一次标签核对开始，或者先去认识田里的草。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            asChild
            className="min-h-[44px] rounded-full bg-[var(--gy-green)] px-5 text-white hover:bg-[var(--gy-green-deep)]"
          >
            <Link to="/identify">
              标签核对
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="min-h-[44px] rounded-full border-[var(--site-border)] bg-[var(--gy-cream)] px-5"
          >
            <Link to="/atlas">识草查药</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
