import React, { useState } from 'react';
import { CameraCapture } from './CameraCapture';
import { invoke } from '../oriel';
import { InventoryItem, VisionDetectedItem } from '../types';

interface ScanViewProps {
  onScanSuccess: () => void;
  defaultLocation?: string;
}

export const ScanView: React.FC<ScanViewProps> = ({ onScanSuccess, defaultLocation = 'fridge' }) => {
  const [location, setLocation] = useState<string>(defaultLocation);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Results to review before persisting to SQLite
  const [detectedItems, setDetectedItems] = useState<(VisionDetectedItem & { selected: boolean; desired: number })[]>([]);
  const [scanSummary, setScanSummary] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  const handleStartAnalysis = async () => {
    if (!selectedImage) return;

    setIsAnalyzing(true);
    setAnalysisError(null);
    setSaveSuccessMsg(null);

    try {
      const res = await invoke('analyze_image', {
        location: location === 'fridge' ? 'Refrigerator' : 'Food Pantry',
        image: selectedImage,
      });

      setScanSummary(res.summary || `Found ${res.items.length} items`);
      setDetectedItems(
        res.items.map((it) => ({
          ...it,
          selected: true,
          desired: it.quantity && it.quantity > 1 ? it.quantity : 1,
        }))
      );
    } catch (err: any) {
      console.error('Vision analysis error:', err);
      const msg = typeof err === 'string' ? err : err?.message || 'Failed to analyze image with AI.';
      setAnalysisError(msg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApplyResults = async () => {
    const selected = detectedItems.filter((it) => it.selected);
    if (selected.length === 0) {
      alert('Please select at least one item to save.');
      return;
    }

    setIsSaving(true);
    try {
      const itemsToSave: InventoryItem[] = selected.map((it) => ({
        name: it.name,
        category: it.category || location,
        location: location === 'fridge' ? 'Fridge' : 'Pantry',
        quantity: it.quantity || 1.0,
        fill_percentage: it.fill_percentage ?? 100.0,
        unit: it.unit || 'unit',
        desired_quantity: it.desired || 1.0,
        notes: it.notes || (it.fill_percentage && it.fill_percentage <= 50 ? 'Usage recognized from photo' : ''),
      }));

      await invoke('apply_scan_results', {
        location,
        summary: scanSummary || `Added ${itemsToSave.length} items from photo`,
        items: itemsToSave as any,
      });

      setSaveSuccessMsg(`Successfully saved ${itemsToSave.length} items into SQLite inventory!`);
      // Reset scan view
      setDetectedItems([]);
      setSelectedImage(null);
      onScanSuccess();
    } catch (err: any) {
      console.error('Failed to save scan results:', err);
      alert('Error saving items: ' + (err?.message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const updateItemField = (index: number, field: string, value: any) => {
    setDetectedItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  return (
    <div className="scan-view-page">
      <div className="view-header">
        <div>
          <h2>AI Inventory Scanner</h2>
          <p className="text-muted">
            Snap photos of your fridge shelves or food pantry to automatically detect items and remaining usage levels.
          </p>
        </div>

        <div className="location-selector">
          <label>Target Area:</label>
          <div className="segmented-control">
            <button
              type="button"
              className={location === 'fridge' ? 'active' : ''}
              onClick={() => setLocation('fridge')}
              disabled={isAnalyzing}
            >
              ❄️ Fridge
            </button>
            <button
              type="button"
              className={location === 'pantry' ? 'active' : ''}
              onClick={() => setLocation('pantry')}
              disabled={isAnalyzing}
            >
              🥫 Pantry
            </button>
            <button
              type="button"
              className={location === 'freezer' ? 'active' : ''}
              onClick={() => setLocation('freezer')}
              disabled={isAnalyzing}
            >
              🧊 Freezer
            </button>
          </div>
        </div>
      </div>

      {saveSuccessMsg && (
        <div className="alert alert-success">
          <span>✓ {saveSuccessMsg}</span>
          <button className="btn-close" onClick={() => setSaveSuccessMsg(null)}>✕</button>
        </div>
      )}

      {analysisError && (
        <div className="alert alert-error">
          <div className="alert-content">
            <strong>AI Vision Failed</strong>
            <p>{analysisError}</p>
            <small>Tip: Verify your API key or model in the <strong>Settings</strong> tab.</small>
          </div>
          <button className="btn-close" onClick={() => setAnalysisError(null)}>✕</button>
        </div>
      )}

      {detectedItems.length === 0 ? (
        <div className="scan-card">
          <CameraCapture
            onImageSelected={(img) => setSelectedImage(img)}
            selectedImage={selectedImage}
            onClear={() => {
              setSelectedImage(null);
              setAnalysisError(null);
            }}
            disabled={isAnalyzing}
          />

          {selectedImage && (
            <div className="scan-actions-bar">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleStartAnalysis}
                disabled={isAnalyzing}
              >
                {isAnalyzing ? (
                  <>
                    <span className="spinner"></span>
                    Analyzing with AI Vision...
                  </>
                ) : (
                  <>✨ Detect Items & Usage in {location === 'fridge' ? 'Fridge' : 'Pantry'}</>
                )}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="review-results-card">
          <div className="review-header">
            <div>
              <h3>AI Detection Results</h3>
              <p className="text-muted">{scanSummary} — Review and confirm items before saving to SQLite:</p>
            </div>
            <div className="review-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDetectedItems([])}
                disabled={isSaving}
              >
                Cancel / New Scan
              </button>
              <button
                type="button"
                className="btn btn-success"
                onClick={handleApplyResults}
                disabled={isSaving || detectedItems.filter((i) => i.selected).length === 0}
              >
                {isSaving ? 'Saving...' : `💾 Save ${detectedItems.filter((i) => i.selected).length} Items to Inventory`}
              </button>
            </div>
          </div>

          <div className="detected-items-table-wrapper">
            <table className="detected-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      checked={detectedItems.every((i) => i.selected)}
                      onChange={(e) =>
                        setDetectedItems((prev) =>
                          prev.map((i) => ({ ...i, selected: e.target.checked }))
                        )
                      }
                    />
                  </th>
                  <th>Item Name</th>
                  <th>Category</th>
                  <th>Quantity & Unit</th>
                  <th>Remaining Fill / Usage</th>
                  <th>Target Desired</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {detectedItems.map((item, idx) => (
                  <tr key={idx} className={item.selected ? '' : 'row-deselected'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(e) => updateItemField(idx, 'selected', e.target.checked)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="input-inline"
                        value={item.name}
                        onChange={(e) => updateItemField(idx, 'name', e.target.value)}
                        placeholder="Item name"
                      />
                    </td>
                    <td>
                      <select
                        className="select-inline"
                        value={item.category || location}
                        onChange={(e) => updateItemField(idx, 'category', e.target.value)}
                      >
                        <option value="pantry">🥫 Pantry</option>
                        <option value="fridge">❄️ Fridge</option>
                        <option value="freezer">🧊 Freezer</option>
                      </select>
                    </td>
                    <td>
                      <div className="qty-unit-cell">
                        <input
                          type="number"
                          className="input-inline input-number"
                          step="0.5"
                          min="0.5"
                          value={item.quantity ?? 1}
                          onChange={(e) => updateItemField(idx, 'quantity', parseFloat(e.target.value) || 1)}
                        />
                        <input
                          type="text"
                          className="input-inline input-unit"
                          value={item.unit || 'unit'}
                          onChange={(e) => updateItemField(idx, 'unit', e.target.value)}
                          placeholder="unit"
                        />
                      </div>
                    </td>
                    <td>
                      <div className="fill-slider-cell">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={item.fill_percentage ?? 100}
                          onChange={(e) => updateItemField(idx, 'fill_percentage', parseInt(e.target.value, 10))}
                        />
                        <span className={`fill-badge ${getFillColorClass(item.fill_percentage ?? 100)}`}>
                          {item.fill_percentage ?? 100}%
                          {(item.fill_percentage ?? 100) === 50 ? ' (Half)' : (item.fill_percentage ?? 100) <= 25 ? ' (Low)' : ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="input-inline input-number"
                        step="1"
                        min="1"
                        value={item.desired}
                        onChange={(e) => updateItemField(idx, 'desired', parseFloat(e.target.value) || 1)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="input-inline input-notes"
                        value={item.notes || ''}
                        onChange={(e) => updateItemField(idx, 'notes', e.target.value)}
                        placeholder="e.g. half usage, opened"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

function getFillColorClass(pct: number): string {
  if (pct <= 25) return 'fill-red';
  if (pct <= 55) return 'fill-amber';
  if (pct <= 80) return 'fill-blue';
  return 'fill-green';
}
