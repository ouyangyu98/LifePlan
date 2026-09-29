import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Bot, CalendarDays, Check, ChevronDown, CodeXml, Copy, Inbox, Laptop, ListChecks, LockKeyhole, Menu, Monitor, Plus, SlidersHorizontal, X, ZoomIn } from "lucide-react";
import downloadData from "./downloads.json";
import "./styles.css";

type Asset = { name: string; url: string; bytes: number; sha256: string };
type Platform = { id: string; name: string; architecture: string; detail: string; extension: string; asset: Asset | null };
const downloads = downloadData as { version: string | null; publishedAt: string | null; releaseUrl: string; platforms: Platform[] };
const base = import.meta.env.BASE_URL;
const source = "https://github.com/ouyangyu98/LifePlan";
const image = (name: string) => `${base}images/${name}.png`;
const productViews = [
  { id: "today", label: "今日事", icon: CalendarDays, title: "把行动，放进真实的一天。", description: "按时间安排行动，在同一行记录复盘。做了什么、下一步是什么，一眼就能看清。", alt: "今日事界面：六个时间段、行动、AI 并行任务与复盘", file: "today" },
  { id: "inbox", label: "事件篮", icon: Inbox, title: "大事拆小，进度一点点积累。", description: "先收集，再拆成可执行的小行动。用分类整理事情，在列表和看板之间自由切换。", alt: "事件篮看板：工作、成长、生活三类事项与子行动", file: "inbox" },
  { id: "insights", label: "心得", icon: BookOpen, title: "留住想法，也留住成长。", description: "一页持续编辑的个人笔记，输入自动保存。值得留下的思考，不必再散落各处。", alt: "心得编辑器：个人行动和 AI 协作的示例笔记", file: "insights" },
] as const;
const questions = [
  { title: "LifePlan 适合什么样的使用方式？", answer: "适合希望把多件事情持续推进的人：在事件篮中整理和拆解，在今日事中分配时间，再记录复盘。既可以管理工作，也可以为学习和生活留出位置。不需要一次启用所有功能。" },
  { title: "这里的 AI 任务会自动执行吗？", answer: "不会。LifePlan 负责安排和跟踪 AI 任务，你仍需要在自己的 AI 工具中执行，再回到这里更新状态、记录结果。AI 任务挂在主行动下面，不会替代主行动，也不会把并行时间重复算作你的个人时长。" },
  { title: "需要注册账号吗？数据存在哪里？", answer: "客户端无需注册即可使用，事件、日程和笔记保存在本机。它不是云端同步服务，不同电脑的数据不会自动同步。请妥善保留本地数据和备份。" },
  { title: "会覆盖原版或个人开发版的数据吗？", answer: "不会。安装后的应用名为 LifePlan OY，安装身份、数据目录和更新源均与原版及 LifePlan Dev 分开。首次启动是空白数据，不会自动导入旧数据；切换使用前请先备份，不要直接覆盖数据库。" },
  { title: "不需要番茄钟、奖励或笔记，可以隐藏吗？", answer: "可以。在设置中按需开启或关闭工作日志、日程模板、奖励池、番茄钟、心得和数据统计。关闭功能不会让它继续占据你的日常界面。" },
  { title: "有 iPhone、Android 或 Linux 安装包吗？", answer: "当前下载区只列出已经准备的桌面平台。iPhone、Android 和 Linux 暂未提供安装包；这个网站是产品介绍与下载站，不是在线版客户端。" },
  { title: "这是原作者的官方发行版吗？", answer: "不是。这是 ouyangyu98 基于 9527GC/LifePlan 持续维护的独立版本。功能与原版有所不同，源代码、版本说明与问题反馈均在本页面链接的 GitHub 仓库中。" },
];

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

function Website() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const modal = useRef<HTMLDialogElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const activeView = productViews[view];
  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setPreferred("windows");
  }, []);
  useEffect(() => {
    if (!zoomed) return;
    lastFocus.current = document.activeElement as HTMLElement;
    modal.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; lastFocus.current?.focus(); };
  }, [zoomed]);
  const closeZoom = () => { modal.current?.close(); setZoomed(false); };
  const copyChecksum = async (platform: Platform) => {
    if (!platform.asset) return;
    try {
      await navigator.clipboard.writeText(platform.asset.sha256);
      setCopied(platform.id); setCopyError("");
    } catch { setCopyError("未能复制，请选中校验值手动复制。"); }
  };
  const selectView = (index: number, focus = false) => {
    setView(index);
    if (focus) document.getElementById(`view-tab-${index}`)?.focus();
  };
  return <>
    <a className="skip-link" href="#main">跳至正文</a>
    <header className="site-header">
      <div className="nav-inner">
        <a className="brand" href="#main" aria-label="LifePlan 首页"><img src={image("logo")} alt="" width="30" height="30" /><span>LifePlan</span><span className="edition">个人维护版</span></a>
        <nav className={menuOpen ? "nav-links open" : "nav-links"} aria-label="主导航">
          <a href="#product" onClick={() => setMenuOpen(false)}>产品一览</a>
          <a href="#parallel" onClick={() => setMenuOpen(false)}>与 AI 并行</a>
          <a href="#questions" onClick={() => setMenuOpen(false)}>常见问题</a>
          <ExternalLink href={source} className="source-link"><CodeXml size={17} />源代码<ArrowUpRight size={14} /></ExternalLink>
        </nav>
        <a className="nav-download" href="#downloads">下载<ArrowDownToLine size={15} /></a>
        <button className="menu-toggle icon-button" type="button" aria-label={menuOpen ? "关闭导航" : "打开导航"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button>
      </div>
    </header>
    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow"><span className="status-dot" />给每一天，一个清晰的开始</div>
          <h1 id="hero-title">LifePlan<span className="hero-period">.</span></h1>
          <p className="hero-tagline">从想做，到做到。</p>
          <p className="hero-description">把事情拆成行动，把行动放进每一天。<br />和 AI 并行推进，也给自己留一点余地。</p>
          <div className="hero-actions"><a href="#downloads" className="button primary">{downloads.version ? "下载 LifePlan" : "查看下载版本"}<ArrowDownToLine size={18} /></a><a href="#product" className="button text-button">先看一看<ArrowDown size={17} /></a></div>
          <div className="hero-meta"><span>Windows & macOS</span><span>本地保存</span><span>无需注册</span></div>
        </div>
        <img className="hero-product" src={image("timeline")} alt="LifePlan 时间表：把每日行动、AI 并行任务和复盘放在一起" width="1764" height="536" fetchPriority="high" />
      </section>
      <div className="principles-strip" aria-label="产品工作流程">
        <div><Inbox size={18} /><span>想法有归处</span></div><ArrowRight size={15} className="strip-arrow" />
        <div><ListChecks size={18} /><span>行动有下一步</span></div><ArrowRight size={15} className="strip-arrow" />
        <div><CalendarDays size={18} /><span>每天有安排</span></div><ArrowRight size={15} className="strip-arrow" />
        <div><BookOpen size={18} /><span>经历有回响</span></div>
      </div>

      <section className="section product-section" id="product" aria-labelledby="product-title">
        <div className="section-heading"><div><div className="eyebrow">01 / 让事情向前走</div><h2 id="product-title">事情很多。<br />下一步，可以很清楚。</h2></div><p>不用把所有事都挤进今天。<br />先整理，再安排，按照自己的节奏推进。</p></div>
        <div className="product-tabs" role="tablist" aria-label="产品界面">
          {productViews.map((item, index) => <button key={item.id} id={`view-tab-${index}`} type="button" role="tab" aria-selected={view === index} aria-controls="product-panel" tabIndex={view === index ? 0 : -1} onClick={() => selectView(index)} onKeyDown={event => {
            if (event.key === "ArrowRight") { event.preventDefault(); selectView((view + 1) % productViews.length, true); }
            if (event.key === "ArrowLeft") { event.preventDefault(); selectView((view + productViews.length - 1) % productViews.length, true); }
            if (event.key === "Home") { event.preventDefault(); selectView(0, true); }
            if (event.key === "End") { event.preventDefault(); selectView(productViews.length - 1, true); }
          }}><item.icon size={18} />{item.label}{item.id === "insights" && <span className="optional-label">可选</span>}</button>)}
        </div>
        <div id="product-panel" role="tabpanel" aria-labelledby={`view-tab-${view}`} tabIndex={0}>
          <button className="product-image-button" type="button" aria-label={`放大查看${activeView.label}界面`} onClick={() => setZoomed(true)}>
            <img src={image(activeView.file)} alt={activeView.alt} width="2040" height="1230" loading="lazy" />
            <span className="zoom-label"><ZoomIn size={17} />查看大图</span>
          </button>
          <div className="product-caption"><div><h3>{activeView.title}</h3><p>{activeView.description}</p></div><span>真实界面 · 示例数据</span></div>
        </div>
      </section>

      <section className="parallel-section" id="parallel" aria-labelledby="parallel-title">
        <div className="section">
          <div className="section-heading"><div><div className="eyebrow">02 / 人与 AI，各自向前</div><h2 id="parallel-title">你在思考。<br /><span>AI 也在推进。</span></h2></div><p>一段时间，不止一条进度。<br />主行动下方，给 AI 的并行任务留一个位置。</p></div>
          <div className="parallel-example">
            <div className="example-header"><span><CalendarDays size={16} />一个下午的安排</span><span>13:30 — 15:00</span></div>
            <img src={image("parallel")} alt="主行动“完善产品方案”下挂载 AI 任务“整理竞品案例与差异”" width="1764" height="126" loading="lazy" />
            <div className="example-legend"><span><span className="legend-dot human" />我负责判断、创作和取舍</span><span><Bot size={17} />AI 整理资料，我回看结果</span></div>
          </div>
          <div className="parallel-notes">
            <div><span className="small-number">01</span><h3>同一个事件池</h3><p>普通行动和 AI 任务来自同一处，不必维护两套清单。</p></div>
            <div><span className="small-number">02</span><h3>各自的进度</h3><p>AI 任务有自己的状态和结果，完成它不会自动完成主行动。</p></div>
            <div><span className="small-number">03</span><h3>不打扰平常的一天</h3><p>不挂 AI 任务时，照常使用简洁的时间表。</p></div>
          </div>
          <p className="honest-note"><Bot size={16} />LifePlan 记录与跟踪 AI 任务，不代替你在 AI 工具中执行任务。</p>
        </div>
      </section>

      <section className="section choice-section" aria-labelledby="choice-title">
        <div className="choice-copy"><div className="eyebrow">03 / 保留需要的，关掉多余的</div><h2 id="choice-title">工具，应该适应你。</h2><p>不是每一天都需要完整的效率仪式。<br />保留事件篮和今日事，其余功能由你决定。</p><span className="choice-footnote"><SlidersHorizontal size={17} />在客户端设置中按需开启</span></div>
        <div className="optional-list">
          {[["心得", "持续编辑，自动保存"], ["数据统计", "查看已安排时长与分类占比"], ["番茄钟", "为专注和休息留出节奏"], ["工作日志", "把一天的工作整理成记录"], ["日程模板", "复用适合自己的时间安排"], ["奖励池", "给自己的推进一些鼓励"]].map(([name, detail]) => <div className="optional-item" key={name}><Check size={16} /><span>{name}</span><span>{detail}</span></div>)}
        </div>
      </section>

      <section className="download-section" id="downloads" aria-labelledby="download-title">
        <div className="section">
          <div className="section-heading"><div><div className="eyebrow">开始你自己的节奏</div><h2 id="download-title">下一步，从今天开始。</h2></div><div className="release-meta">{downloads.version ? <><span className="release-badge"><span className="status-dot" />{downloads.version}</span><p>{downloads.publishedAt?.slice(0, 10)} 发布</p></> : <span className="release-badge">首个个人维护版准备中</span>}</div></div>
          <div className="download-grid">
            {downloads.platforms.map(platform => <article key={platform.id} className={`download-card${preferred === platform.id ? " recommended" : ""}`}>
              <div className="platform-header">{platform.id === "windows" ? <Monitor size={30} strokeWidth={1.5} /> : <Laptop size={30} strokeWidth={1.5} />}{preferred === platform.id && <span className="recommended-label">适合当前电脑</span>}</div>
              <h3>{platform.name}</h3><p className="architecture">{platform.architecture}</p><p className="platform-detail">{platform.detail}</p>
              <div className="asset-meta"><span>{platform.extension}</span><span>{platform.asset ? `${(platform.asset.bytes / 1024 / 1024).toFixed(1)} MB` : "尚未发布"}</span></div>
              {platform.asset ? <a className="button download-button" href={platform.asset.url} aria-label={`下载 ${platform.name} ${platform.architecture}`}><ArrowDownToLine size={17} />下载 {platform.extension}<ArrowUpRight size={16} /></a> : <button className="button download-button" type="button" disabled><ArrowDownToLine size={17} />安装包准备中</button>}
              {platform.asset && <details className="checksum"><summary>SHA-256 校验值<ChevronDown size={14} /></summary><div><code>{platform.asset.sha256}</code><button type="button" className="icon-button" onClick={() => void copyChecksum(platform)} aria-label={copied === platform.id ? "已复制校验值" : `复制 ${platform.name} ${platform.architecture} 校验值`} title="复制校验值">{copied === platform.id ? <Check size={17} /> : <Copy size={17} />}</button></div></details>}
            </article>)}
          </div>
          <p className="copy-status" role="status">{copyError || (copied ? "校验值已复制" : "")}</p>
          <div className="download-footer"><p><LockKeyhole size={16} />无需账号，本地保存。暂不提供手机端与云同步。</p><ExternalLink href={downloads.releaseUrl}>版本说明与历史下载<ArrowUpRight size={15} /></ExternalLink></div>
          <details className="installation-note"><summary>安装前需要知道什么？<Plus size={16} /></summary><p>安装后的应用名为 LifePlan OY，与原版和 LifePlan Dev 独立存储，首次打开不会自动带入旧数据。下载与你的系统和芯片匹配的安装包，Mac 可在“关于本机”中查看芯片类型。当前尚未提供商业代码签名或 Apple 公证，Mac 安装包使用临时本地签名，系统仍可能拦截；请先确认下载来源与文件校验值，不要关闭系统安全保护。切换版本前，请保留已有数据和备份。</p></details>
        </div>
      </section>

      <section className="section faq-section" id="questions" aria-labelledby="faq-title">
        <div><div className="eyebrow">再多了解一点</div><h2 id="faq-title">常见问题</h2><p>简单的工具，<br />也把边界说清楚。</p></div>
        <div className="faq-list">{questions.map(question => <details key={question.title}><summary>{question.title}<Plus size={18} /></summary><p>{question.answer}</p></details>)}</div>
      </section>
    </main>
    <footer className="site-footer"><div><a className="brand" href="#main"><img src={image("logo")} alt="" width="28" height="28" /><span>LifePlan</span></a><p>按自己的节奏，把事情向前推进。</p></div><div className="footer-links"><ExternalLink href={source}>源代码<ArrowUpRight size={14} /></ExternalLink><ExternalLink href={`${source}/issues`}>问题反馈<ArrowUpRight size={14} /></ExternalLink><a href="/">项目主页<ArrowUpRight size={14} /></a></div><div className="footer-bottom"><span>由 ouyangyu98 持续维护</span><span>基于 <ExternalLink href="https://github.com/9527GC/LifePlan">9527GC / LifePlan</ExternalLink> 构建，感谢原作者。</span></div></footer>
    {zoomed && <dialog className="image-dialog" ref={modal} aria-label={`${activeView.label}界面大图`} onCancel={closeZoom} onClick={event => { if (event.target === event.currentTarget) closeZoom(); }}><button type="button" className="icon-button close-image" aria-label="关闭大图" onClick={closeZoom} autoFocus><X size={24} /></button><img src={image(activeView.file)} alt={activeView.alt} /><p>真实产品界面 · 虚构示例数据</p></dialog>}
  </>;
}

createRoot(document.getElementById("root")!).render(<Website />);
