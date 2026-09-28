import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";

type Props = {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  showToolbar?: boolean;
  // 由父组件传入的 ref，挂载后写入 editor.getHTML()，供“复制为富文本”使用
  getHtmlRef?: { current: () => string };
};

// 所见即所得编辑器：不渲染任何工具条/菜单，格式化通过 Markdown 语法或快捷键（Ctrl/Cmd+B、Shift+Enter 换行）完成；对外读写始终是 Markdown 文本，兼容既有日志数据与 AI 链路。
// breaks:true 让段落内的换行（含 Shift+Enter 硬换行）在解析时保留；层级缩进请用嵌套列表，编辑器会原样保留其缩进与换行。
export default function MarkdownEditor({ value, onChange, placeholder, minHeight = 160, maxHeight, showToolbar = false, getHtmlRef }: Props) {
  const latestRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Markdown.configure({ html: false, tightLists: true, breaks: true }),
      Placeholder.configure({ placeholder: placeholder || "" }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: "md-wysiwyg",
        style: `min-height:${minHeight}px;${maxHeight ? `max-height:${maxHeight}px;overflow:auto;` : ""}`,
      },
    },
    onUpdate: ({ editor }) => {
      const md = (editor.storage as any)?.markdown?.getMarkdown?.() as string ?? "";
      latestRef.current = md;
      onChangeRef.current(md);
    },
  });

  // 外部值变化（切换日期 / AI 生成回填）时同步进编辑器；打字过程中 value 与 latestRef 相同则不重置，避免光标跳动。
  useEffect(() => {
    if (!editor) return;
    if (value !== latestRef.current) {
      latestRef.current = value;
      editor.commands.setContent(value || "", false);
    }
  }, [value, editor]);

  // 暴露富文本 HTML 读取能力
  useEffect(() => {
    if (getHtmlRef) getHtmlRef.current = () => editor?.getHTML() ?? "";
  }, [editor, getHtmlRef]);

  return (
    <div className={`markdown-editor ${showToolbar ? "markdown-editor-with-toolbar" : ""}`}>
      {showToolbar && editor && (
        <div className="markdown-editor-toolbar" role="toolbar" aria-label="心得编辑工具">
          <button type="button" aria-label="粗体" title="粗体" onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive("bold") ? "is-active" : ""}><Bold size={15} /></button>
          <button type="button" aria-label="斜体" title="斜体" onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive("italic") ? "is-active" : ""}><Italic size={15} /></button>
          <button type="button" aria-label="删除线" title="删除线" onClick={() => editor.chain().focus().toggleStrike().run()} className={editor.isActive("strike") ? "is-active" : ""}><Strikethrough size={15} /></button>
          <span className="markdown-editor-toolbar-divider" />
          <button type="button" aria-label="一级标题" title="一级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={editor.isActive("heading", { level: 1 }) ? "is-active" : ""}><Heading1 size={15} /></button>
          <button type="button" aria-label="二级标题" title="二级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={editor.isActive("heading", { level: 2 }) ? "is-active" : ""}><Heading2 size={15} /></button>
          <button type="button" aria-label="无序列表" title="无序列表" onClick={() => editor.chain().focus().toggleBulletList().run()} className={editor.isActive("bulletList") ? "is-active" : ""}><List size={15} /></button>
          <button type="button" aria-label="有序列表" title="有序列表" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={editor.isActive("orderedList") ? "is-active" : ""}><ListOrdered size={15} /></button>
          <button type="button" aria-label="引用" title="引用" onClick={() => editor.chain().focus().toggleBlockquote().run()} className={editor.isActive("blockquote") ? "is-active" : ""}><Quote size={15} /></button>
          <button type="button" aria-label="代码" title="代码" onClick={() => editor.chain().focus().toggleCode().run()} className={editor.isActive("code") ? "is-active" : ""}><Code size={15} /></button>
          <span className="markdown-editor-toolbar-spacer" />
          <button type="button" aria-label="撤销" title="撤销" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}><Undo2 size={15} /></button>
          <button type="button" aria-label="重做" title="重做" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}><Redo2 size={15} /></button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
