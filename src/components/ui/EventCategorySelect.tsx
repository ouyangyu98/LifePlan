import { useState } from "react";
import { Button, Input, Select, message } from "antd";
import { Plus } from "lucide-react";
import { eventCategoriesApi } from "@/lib/api";
import { userFacingError } from "@/lib/errors";
import type { EventCategory } from "@/types";

export default function EventCategorySelect({ value, onChange, categories, onCreated }: {
  value?: number;
  onChange?: (value?: number) => void;
  categories: EventCategory[];
  onCreated: (category: EventCategory) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const create = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const category = await eventCategoriesApi.create({ name: name.trim(), color: "#1778FF" });
      onCreated(category);
      onChange?.(category.id);
      setName("");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };
  return <Select
    aria-label="事件分类"
    className="event-category-select"
    value={value}
    onChange={onChange}
    allowClear
    placeholder="未分类"
    options={categories.map((category) => ({
      value: category.id,
      label: <span className="category-option"><i style={{ backgroundColor: category.color }} />{category.name}</span>,
    }))}
    popupRender={(menu) => <>{menu}<div className="category-quick-create" onKeyDown={(event) => event.stopPropagation()}>
      <Input aria-label="新分类名称" placeholder="新分类名称" maxLength={20} value={name} onChange={(event) => setName(event.target.value)} onPressEnter={(event) => { event.preventDefault(); void create(); }} />
      <Button aria-label="新增并选择分类" title="新增并选择分类" icon={<Plus size={14} />} loading={saving} disabled={!name.trim()} onClick={() => void create()} />
    </div></>}
  />;
}
