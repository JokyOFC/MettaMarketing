import { useEffect, useId, useState } from "react";
import { api } from "../../api/client.js";
import { Button, Drawer, Field, Input, Textarea, useToast } from "../../ui/index.js";
import { InternalBadge, clean, useForm } from "./crmShared.jsx";
import "./crm.css";

const EMPTY = { name: "", description: "", internalNotes: "" };

// Creates a brand for a client or edits one (name, description, internal notes).
// Guidelines, colors and fonts live in the identity workspace (/admin/marcas/:id).
export default function BrandDrawer({ open, onClose, clientId, clientName, brand = null, onSaved }) {
  const editing = Boolean(brand);
  const toast = useToast();
  const formId = useId();
  const form = useForm(EMPTY);
  const { bind, fieldError, values } = form;
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.reset(
      brand
        ? { name: brand.name ?? "", description: brand.description ?? "", internalNotes: brand.internalNotes ?? "" }
        : EMPTY,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brand?.id]);

  const submit = async (event) => {
    event.preventDefault();
    if (!values.name.trim()) {
      form.setErrors({ name: "Dê um nome à marca." });
      return;
    }
    const body = { name: values.name.trim(), description: clean(values.description), internalNotes: clean(values.internalNotes) };
    setSaving(true);
    try {
      const res = editing ? await api.patch(`/brands/${brand.id}`, body) : await api.post(`/clients/${clientId}/brands`, body);
      toast.success(editing ? "Marca atualizada." : `Marca ${res.brand.name} criada.`);
      onSaved?.(res.brand);
      onClose?.();
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="sm"
      eyebrow={clientName}
      title={editing ? `Editar ${brand.name}` : "Nova marca"}
      description={
        editing
          ? "Orientações de uso, cores e tipografia ficam na identidade da marca."
          : "Cada marca tem arquivos, projetos e identidade próprios. As pessoas do cliente veem todas as marcas ativas dele."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {editing ? "Salvar marca" : "Criar marca"}
          </Button>
        </>
      }
    >
      <form ref={form.ref} id={formId} className="crm-form" onSubmit={submit} noValidate>
        <Field label="Nome da marca" required error={fieldError("name")}>
          <Input {...bind("name")} data-autofocus />
        </Field>
        <Field label="Descrição" optional error={fieldError("description")}>
          <Textarea {...bind("description")} rows={3} autoGrow placeholder="Linha de produto, público ou posicionamento." />
        </Field>
        <Field
          label="Notas internas"
          optional
          labelAside={<InternalBadge />}
          error={fieldError("internalNotes")}
          hint="Nunca aparecem para o cliente."
        >
          <Textarea {...bind("internalNotes")} rows={3} autoGrow />
        </Field>
      </form>
    </Drawer>
  );
}
