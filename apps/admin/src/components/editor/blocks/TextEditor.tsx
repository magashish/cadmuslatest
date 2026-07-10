import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import type { TextBlock } from "@cadmus/shared";

const VARIANTS: TextBlock["variant"][] = ["single-col", "single-col-dropcap", "two-col", "with-image"];

interface Props {
  data: TextBlock["data"];
  variant: TextBlock["variant"];
  onDataChange: (data: TextBlock["data"]) => void;
  onVariantChange: (variant: TextBlock["variant"]) => void;
}

export function TextEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const update = (field: keyof TextBlock["data"], value: string) => {
    onDataChange({ ...data, [field]: value });
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Write your text content here..." }),
    ],
    content: data.content || "",
    onUpdate: ({ editor: ed }) => {
      onDataChange({ ...data, content: ed.getHTML() });
    },
  });

  return (
    <div>
      <div className="form-group">
        <label>Variant</label>
        <div className="variant-picker-inline">
          {VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              className={`variant-chip${variant === v ? " active" : ""}`}
              onClick={() => onVariantChange(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="form-group">
        <label>Content</label>
        {editor && (
          <div className="rte-toolbar">
            <button
              type="button"
              className={editor.isActive("bold") ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title="Bold"
            >
              B
            </button>
            <button
              type="button"
              className={editor.isActive("italic") ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title="Italic"
            >
              <em>I</em>
            </button>
            <span className="rte-sep" />
            <button
              type="button"
              className={editor.isActive("heading", { level: 2 }) ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              title="Heading 2"
            >
              H2
            </button>
            <button
              type="button"
              className={editor.isActive("heading", { level: 3 }) ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              title="Heading 3"
            >
              H3
            </button>
            <span className="rte-sep" />
            <button
              type="button"
              className={editor.isActive("bulletList") ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              title="Bullet list"
            >
              &bull;
            </button>
            <button
              type="button"
              className={editor.isActive("orderedList") ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              title="Numbered list"
            >
              1.
            </button>
            <button
              type="button"
              className={editor.isActive("blockquote") ? "rte-btn active" : "rte-btn"}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              title="Quote"
            >
              &ldquo;
            </button>
            <span className="rte-sep" />
            <button
              type="button"
              className="rte-btn"
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
              title="Horizontal rule"
            >
              &mdash;
            </button>
          </div>
        )}
        <EditorContent editor={editor} className="rte-editor" />
      </div>
      {variant === "with-image" && (
        <>
          <div className="form-group">
            <label>Image URL</label>
            <input
              type="text"
              value={data.imageUrl ?? ""}
              onChange={(e) => update("imageUrl", e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="form-group">
            <label>Image Position</label>
            <select
              value={data.imagePosition ?? "right"}
              onChange={(e) => update("imagePosition", e.target.value)}
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}
