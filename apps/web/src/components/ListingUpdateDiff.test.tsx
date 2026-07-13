import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListingUpdateDiff } from './ListingUpdateDiff';

describe('ListingUpdateDiff', () => {
  const baseProps = {
    fields: [
      { key: 'title', label: 'Title', current: 'Old Title', proposed: 'New Title', maxLength: 30 },
      { key: 'keywords', label: 'Keywords', current: 'a,b', proposed: 'a,b,c', maxLength: 100 },
    ],
    onChange: vi.fn(),
    onToggle: vi.fn(),
    checked: { title: true, keywords: true },
  };

  it('renders field rows', () => {
    render(<ListingUpdateDiff {...baseProps} />);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Keywords')).toBeTruthy();
  });

  it('shows char counts', () => {
    render(<ListingUpdateDiff {...baseProps} />);
    // "New Title" = 9 chars, limit = 30
    expect(screen.getByText('9/30')).toBeTruthy();
  });

  it('shows red char count when over limit', () => {
    const over = {
      ...baseProps,
      fields: [{ key: 'title', label: 'Title', current: 'Old', proposed: 'A'.repeat(31), maxLength: 30 }],
    };
    render(<ListingUpdateDiff {...over} />);
    const counter = screen.getByText('31/30');
    expect(counter.className).toMatch(/red|danger|over/);
  });

  it('calls onChange when proposed value is edited', () => {
    const onChange = vi.fn();
    render(<ListingUpdateDiff {...baseProps} onChange={onChange} />);
    // The proposed value cell is contenteditable — simulate input
    const cells = document.querySelectorAll('[contenteditable="true"]');
    fireEvent.input(cells[0], { target: { innerText: 'Updated Title' } });
    expect(onChange).toHaveBeenCalledWith('title', 'Updated Title');
  });
});
