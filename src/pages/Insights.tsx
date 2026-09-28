import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spin, Typography } from "antd";
import { Check, LoaderCircle } from "lucide-react";
import MarkdownEditor from "@/components/ui/MarkdownEditor";
import { loadInsights, saveInsights } from "@/lib/insightsPersistence";
import { userFacingError } from "@/lib/errors";

export default function Insights() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);
  const latestContent = useRef("");
  const savedContent = useRef("");
  const spaceId = useRef("");
  const pendingWrites = useRef(0);
  const revision = useRef(0);
  const mounted = useRef(false);
  const draftKey = () => `lifeplan-insights-draft:${spaceId.current}`;

  const flush = async () => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    if (!spaceId.current || (latestContent.current === savedContent.current && pendingWrites.current === 0)) return;
    const value = latestContent.current;
    const savingRevision = revision.current;
    pendingWrites.current += 1;
    if (mounted.current) setSaving(true);
    try {
      await saveInsights(value, spaceId.current);
      savedContent.current = value;
      if (savingRevision === revision.current && localStorage.getItem(draftKey()) === value) localStorage.removeItem(draftKey());
      if (mounted.current) {
        setSaved(value === latestContent.current);
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError(userFacingError(cause));
    } finally {
      pendingWrites.current -= 1;
      if (mounted.current) setSaving(pendingWrites.current > 0);
    }
  };

  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    void loadInsights()
      .then((note) => {
        if (disposed) return;
        spaceId.current = note.space_id;
        savedContent.current = note.content;
        let draft: string | null = null;
        try { draft = localStorage.getItem(draftKey()); } catch { /* Database remains authoritative. */ }
        latestContent.current = draft ?? note.content;
        setContent(latestContent.current);
        setSaved(draft === null || draft === note.content);
        setReady(true);
        if (draft !== null && draft !== note.content) void flush();
      })
      .catch((cause) => { if (!disposed) setError(userFacingError(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    const onHide = () => { if (document.visibilityState === "hidden") void flush(); };
    const onLeave = () => { void flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      disposed = true;
      mounted.current = false;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onLeave);
      void flush();
    };
  }, []);

  const save = (nextContent: string) => {
    revision.current += 1;
    latestContent.current = nextContent;
    setContent(nextContent);
    setSaved(false);
    try { localStorage.setItem(draftKey(), nextContent); }
    catch {
      setError("本地草稿暂存失败，正在直接保存到数据库。");
      void flush();
    }
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flush(); }, 400);
  };

  return (
    <div className="page insights-page">
      <header className="page-header insights-header">
        <div>
          <Typography.Title level={2} className="page-title">心得</Typography.Title>
        </div>
        <div className="insights-save-state" aria-live="polite">
          {error ? "保存异常" : loading ? "正在读取…" : saving ? <><LoaderCircle size={14} className="insights-saving-icon" />正在保存</> : saved ? <><Check size={14} />已保存</> : "待保存"}
        </div>
      </header>
      {error && <Alert className="page-alert" type="error" showIcon message={error} action={<Button onClick={() => ready ? void flush() : window.location.reload()}>重试</Button>} />}
      <section className="insights-editor-shell">
        {loading ? <div className="insights-loading"><Spin /></div> : ready && <MarkdownEditor value={content} onChange={save} placeholder="写下今天的心得…" minHeight={420} showToolbar />}
      </section>
    </div>
  );
}
