import React, { useRef, useState } from 'react';
import type { ProposedFields } from '../lib/api';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  keywords: 'Keywords',
  description: 'Description',
  promotionalText: 'Promotional Text',
  releaseNotes: "What's New",
};

const FIELD_LIMITS: Record<string, number> = {
  title: 30,
  subtitle: 30,
  keywords: 100,
  description: 4000,
  promotionalText: 170,
  releaseNotes: 4000,
};

export interface DiffField {
  key: keyof ProposedFields;
  label: string;
  current: string | null;
  proposed: string;
  maxLength: number;
}

interface ListingUpdateDiffProps {
  fields: DiffField[];
  checked: Partial<Record<keyof ProposedFields, boolean>>;
  onChange: (key: keyof ProposedFields, value: string) => void;
  onToggle: (key: keyof ProposedFields, checked: boolean) => void;
}

export function ListingUpdateDiff({ fields, checked, onChange, onToggle }: ListingUpdateDiffProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #333' }}>
          <th style={{ textAlign: 'left', padding: '6px 8px', width: 120 }}>Field</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Current</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Proposed</th>
          <th style={{ textAlign: 'center', padding: '6px 8px', width: 40 }}>✓</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <DiffRow
            key={field.key}
            field={field}
            isChecked={checked[field.key] !== false}
            onChange={onChange}
            onToggle={onToggle}
          />
        ))}
      </tbody>
    </table>
  );
}

function DiffRow({
  field,
  isChecked,
  onChange,
  onToggle,
}: {
  field: DiffField;
  isChecked: boolean;
  onChange: (key: keyof ProposedFields, value: string) => void;
  onToggle: (key: keyof ProposedFields, checked: boolean) => void;
}) {
  const editRef = useRef<HTMLDivElement>(null);
  const [charCount, setCharCount] = useState(field.proposed.length);
  const isOver = charCount > field.maxLength;

  return (
    <tr style={{ borderBottom: '1px solid #222', opacity: isChecked ? 1 : 0.5 }}>
      <td style={{ padding: '8px', fontWeight: 500, verticalAlign: 'top' }}>{field.label}</td>
      <td style={{ padding: '8px', color: '#888', verticalAlign: 'top', maxWidth: 200, wordBreak: 'break-word' }}>
        {field.current ?? <em style={{ color: '#555' }}>—</em>}
      </td>
      <td style={{ padding: '8px', verticalAlign: 'top' }}>
        <div
          ref={editRef}
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => {
            const text = (e.target as HTMLDivElement).innerText;
            setCharCount(text.length);
            onChange(field.key, text);
          }}
          style={{
            minHeight: 24,
            outline: 'none',
            borderBottom: '1px solid #444',
            paddingBottom: 2,
            wordBreak: 'break-word',
          }}
        >
          {field.proposed}
        </div>
        <span
          style={{ fontSize: 11, color: isOver ? '#f55' : '#666' }}
          className={isOver ? 'char-count over' : 'char-count'}
        >
          {charCount}/{field.maxLength}
        </span>
      </td>
      <td style={{ padding: '8px', textAlign: 'center', verticalAlign: 'top' }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => onToggle(field.key, e.target.checked)}
        />
      </td>
    </tr>
  );
}

// Helper: build DiffField array from a ProposedFields object and current values
export function buildDiffFields(
  proposed: ProposedFields,
  current: Record<string, string | null>,
): DiffField[] {
  return (Object.keys(proposed) as Array<keyof ProposedFields>)
    .filter((key) => proposed[key] !== undefined)
    .map((key) => ({
      key,
      label: FIELD_LABELS[key] ?? key,
      current: current[key] ?? null,
      proposed: proposed[key]!,
      maxLength: FIELD_LIMITS[key] ?? 4000,
    }));
}
