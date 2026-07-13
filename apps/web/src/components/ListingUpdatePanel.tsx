import React, { useState, useCallback } from 'react';
import {
  generateListingUpdate,
  submitListingUpdate,
  type ProposedFields,
  type ListingUpdate,
} from '../lib/api';
import { ListingUpdateDiff, buildDiffFields } from './ListingUpdateDiff';

type PanelState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | {
      phase: 'draft';
      update: ListingUpdate;
      currentFields: Record<string, string | null>;
      edits: ProposedFields;
      checked: Partial<Record<keyof ProposedFields, boolean>>;
    }
  | { phase: 'submitting' }
  | { phase: 'submitted'; update: ListingUpdate }
  | { phase: 'error'; message: string };

interface ListingUpdatePanelProps {
  auditJobId: string;
  appId: string;
  existingUpdate?: ListingUpdate | null;
}

export function ListingUpdatePanel({ auditJobId, appId, existingUpdate }: ListingUpdatePanelProps) {
  const [state, setState] = useState<PanelState>(() => {
    if (!existingUpdate) return { phase: 'idle' };
    if (existingUpdate.status === 'draft') return { phase: 'idle' }; // will re-generate
    return { phase: 'submitted', update: existingUpdate };
  });

  const handleGenerate = useCallback(async () => {
    setState({ phase: 'generating' });
    try {
      const result = await generateListingUpdate(auditJobId);
      const initialEdits = { ...result.proposedFields };
      const initialChecked: Partial<Record<keyof ProposedFields, boolean>> = {};
      (Object.keys(initialEdits) as Array<keyof ProposedFields>).forEach((k) => {
        initialChecked[k] = true;
      });
      setState({
        phase: 'draft',
        update: {
          ...existingUpdate,
          id: result.updateId,
          status: 'draft',
          proposedFields: result.proposedFields,
        } as ListingUpdate,
        currentFields: result.currentFields,
        edits: initialEdits,
        checked: initialChecked,
      });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, [auditJobId, existingUpdate]);

  const handleFieldChange = useCallback((key: keyof ProposedFields, value: string) => {
    setState((prev) => {
      if (prev.phase !== 'draft') return prev;
      return { ...prev, edits: { ...prev.edits, [key]: value } };
    });
  }, []);

  const handleToggle = useCallback((key: keyof ProposedFields, checked: boolean) => {
    setState((prev) => {
      if (prev.phase !== 'draft') return prev;
      return { ...prev, checked: { ...prev.checked, [key]: checked } };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (state.phase !== 'draft') return;
    const approvedFields: ProposedFields = {};
    (Object.keys(state.edits) as Array<keyof ProposedFields>).forEach((key) => {
      if (state.checked[key] !== false && state.edits[key] !== undefined) {
        (approvedFields as Record<string, string>)[key] = state.edits[key]!;
      }
    });
    setState({ phase: 'submitting' });
    try {
      const result = await submitListingUpdate(state.update.id, approvedFields);
      setState({ phase: 'submitted', update: result.update });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, [state]);

  if (state.phase === 'idle') {
    const isRejected = existingUpdate?.status === 'rejected';
    return (
      <div style={{ marginTop: 16 }}>
        {isRejected && (
          <div style={{ marginBottom: 8, color: '#f55', fontSize: 13 }}>
            Apple rejected the last submission
            {existingUpdate?.rejectionReason ? `: ${existingUpdate.rejectionReason}` : ''}.
          </div>
        )}
        <button onClick={handleGenerate} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          {isRejected ? 'Fix and Resubmit' : 'Apply to Listing'}
        </button>
      </div>
    );
  }

  if (state.phase === 'generating') {
    return <div style={{ marginTop: 16, color: '#888' }}>Generating new values…</div>;
  }

  if (state.phase === 'draft') {
    const diffFields = buildDiffFields(state.edits, state.currentFields);
    return (
      <div style={{ marginTop: 16 }}>
        <ListingUpdateDiff
          fields={diffFields}
          checked={state.checked}
          onChange={handleFieldChange}
          onToggle={handleToggle}
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={handleSubmit} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Submit to ASC
          </button>
          <button
            onClick={() => setState({ phase: 'idle' })}
            style={{ padding: '8px 16px', cursor: 'pointer', opacity: 0.7 }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === 'submitting') {
    return <div style={{ marginTop: 16, color: '#888' }}>Submitting to App Store Connect…</div>;
  }

  if (state.phase === 'submitted') {
    const statusLabels: Record<string, string> = {
      submitted: 'Submitted — waiting for Apple review',
      in_review: 'In Review',
      approved: 'Approved ✓',
      rejected: 'Rejected',
    };
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, color: state.update.status === 'approved' ? '#4f4' : '#aaa' }}>
          {statusLabels[state.update.status] ?? state.update.status}
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ color: '#f55', fontSize: 13, marginBottom: 8 }}>{state.message}</div>
        <button onClick={() => setState({ phase: 'idle' })} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          Try Again
        </button>
      </div>
    );
  }

  return null;
}
