"""
利用明細書 PDF生成モジュール
A4縦、園児ごとに1ページ

構成:
  タイトル → 年月 → 園児名 → 日次テーブル → 請求テーブル → 合計

v5.0:
  - フォント修正: WQY Micro Hei使用（日本語+数字+記号を完全カバー）
  - DroidSansFallbackFullはASCII/数字が欠落するため不可
  - 朝食（breakfast）行の追加
"""

import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Spacer, Paragraph
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Try to register Japanese font
_FONT_NAME = "Helvetica"
_FONT_REGISTERED = False

def _ensure_font():
    global _FONT_NAME, _FONT_REGISTERED
    if _FONT_REGISTERED:
        return
    
    # ★ v5.0: フォント優先順位を修正
    # WQY Micro Hei: 日本語+ASCII+数字+記号を全てカバー（最優先）
    # DroidSansFallbackFull: CJK専用でASCII/数字が欠落するため使用不可
    # NotoSansCJK: PostScript outlines のため ReportLab 非対応
    font_paths = [
        # ★ WQY Micro Hei (最優先 — 日本語+数字+記号の完全カバーを確認済み)
        ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", 0),
        # WQY Zen Hei (alternative)
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        # Arphic fonts (TrueType, compatible)
        ("/usr/share/fonts/truetype/arphic/uming.ttc", None),
        ("/usr/share/fonts/truetype/arphic/ukai.ttc", None),
        # ★ DroidSansFallbackFull は意図的にスキップ（ASCII欠落問題あり）
    ]
    
    for path_info in font_paths:
        if isinstance(path_info, tuple):
            path, subfont_idx = path_info
        else:
            path, subfont_idx = path_info, None
        
        if not os.path.exists(path):
            continue
        try:
            if subfont_idx is not None:
                pdfmetrics.registerFont(TTFont("JapaneseFont", path, subfontIndex=subfont_idx))
            else:
                pdfmetrics.registerFont(TTFont("JapaneseFont", path))
            _FONT_NAME = "JapaneseFont"
            _FONT_REGISTERED = True
            print(f"PDF font registered: {path}")
            return
        except Exception as e:
            print(f"Font registration failed for {path}: {e}")
            continue
    
    # Fallback: Helvetica (Japanese characters will show as ■)
    print("WARNING: No Japanese font found. PDF will show ■ for Japanese characters.")
    _FONT_REGISTERED = True  # Prevent retry


def generate_parent_statements(
    output_dir: str,
    children: list[dict],
    usage_facts: list[dict],
    charge_lines: list[dict],
    year: int,
    month: int,
) -> list[dict]:
    """
    Generate PDF statements for all children.
    Returns list of {"path": str, "name": str, "child_name": str}
    """
    _ensure_font()
    
    pdf_files = []
    
    for child in children:
        child_id = child.get("lukumi_id", "")
        child_name = child.get("name", "")
        
        # Filter data for this child
        child_facts = sorted(
            [f for f in usage_facts if f["child_id"] == child_id],
            key=lambda f: f["day"]
        )
        child_charges = [cl for cl in charge_lines if cl["child_id"] == child_id]
        
        # Generate PDF
        safe_name = child_name.replace(' ', '_').replace('\u3000', '_').replace('/', '_')
        filename = f"利用明細書_{safe_name}_{year}{month:02d}.pdf"
        filepath = os.path.join(output_dir, filename)
        
        try:
            _generate_single_pdf(filepath, child_name, child_facts, child_charges, year, month)
            pdf_files.append({
                "path": filepath,
                "name": filename,
                "child_name": child_name,
            })
        except Exception as e:
            # ★ Fix #15: Log AND return warning (not silently skip)
            print(f"PDF generation failed for {child_name}: {e}")
            pdf_files.append({
                "path": "",
                "name": filename,
                "child_name": child_name,
                "error": str(e),
            })
    
    return pdf_files


def _generate_single_pdf(
    filepath: str,
    child_name: str,
    facts: list[dict],
    charges: list[dict],
    year: int,
    month: int,
):
    """Generate a single child's statement PDF"""
    doc = SimpleDocTemplate(
        filepath,
        pagesize=A4,
        leftMargin=15*mm,
        rightMargin=15*mm,
        topMargin=15*mm,
        bottomMargin=15*mm,
    )
    
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        'Title_JP',
        parent=styles['Title'],
        fontName=_FONT_NAME,
        fontSize=16,
        alignment=1,
    )
    subtitle_style = ParagraphStyle(
        'Subtitle_JP',
        parent=styles['Normal'],
        fontName=_FONT_NAME,
        fontSize=12,
        alignment=1,
    )
    normal_style = ParagraphStyle(
        'Normal_JP',
        parent=styles['Normal'],
        fontName=_FONT_NAME,
        fontSize=9,
    )
    
    elements = []
    
    # Title
    elements.append(Paragraph("利用明細書", title_style))
    elements.append(Spacer(1, 5*mm))
    elements.append(Paragraph(f"{year}年{month}月", subtitle_style))
    elements.append(Spacer(1, 3*mm))
    elements.append(Paragraph(f"{child_name} 様", subtitle_style))
    elements.append(Spacer(1, 5*mm))
    
    # Daily table
    weekdays = ['月', '火', '水', '木', '金', '土', '日']
    import calendar
    import datetime as _dt_mod
    
    header = ['日', '曜', '予定登園', '予定降園', '実績登園', '実績降園', '時間', '状態']
    daily_data = [header]
    
    days_in_month = calendar.monthrange(year, month)[1]
    
    for day in range(1, days_in_month + 1):
        # Find fact for this day
        fact = None
        for f in facts:
            if f["day"] == day:
                fact = f
                break
        
        # Day of week
        dt = _dt_mod.date(year, month, day)
        dow = weekdays[dt.weekday()]
        
        if fact and fact["attendance_status"] != "absent_no_plan":
            row = [
                str(day),
                dow,
                fact.get("planned_start") or "",
                fact.get("planned_end") or "",
                fact.get("actual_checkin") or "",
                fact.get("actual_checkout") or "",
                f"{fact['billing_minutes']}分" if fact.get("billing_minutes") else "",
                _status_label(fact["attendance_status"]),
            ]
        else:
            row = [str(day), dow, "", "", "", "", "", ""]
        
        daily_data.append(row)
    
    col_widths = [20, 20, 45, 45, 45, 45, 35, 35]
    daily_table = Table(daily_data, colWidths=[w*0.6*mm for w in col_widths])
    daily_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), _FONT_NAME),
        ('FONTSIZE', (0, 0), (-1, -1), 6.5),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('ALIGN', (0, 1), (1, -1), 'CENTER'),
        ('ALIGN', (2, 1), (-1, -1), 'CENTER'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0.85, 0.9, 1.0)),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.Color(0.97, 0.97, 0.97)]),
    ]))
    elements.append(daily_table)
    elements.append(Spacer(1, 5*mm))
    
    # Charge table
    charge_header = ['項目', '数量', '単価', '小計']
    charge_data = [charge_header]
    
    type_labels = {
        "monthly_fee": "月額保育料",
        "spot_care": "一時保育料",
        "early_morning": "早朝保育料",
        "extension": "延長保育料",
        "night": "夜間保育料",
        "sick": "病児保育料",
        "breakfast": "朝食代",
        "lunch": "昼食代",
        "am_snack": "朝おやつ代",
        "pm_snack": "午後おやつ代",
        "dinner": "夕食代",
    }
    
    total = 0
    for cl in charges:
        label = type_labels.get(cl["charge_type"], cl["charge_type"])
        charge_data.append([
            label,
            str(cl["quantity"]),
            f"¥{cl['unit_price']:,}",
            f"¥{cl['subtotal']:,}",
        ])
        total += cl["subtotal"]
    
    charge_data.append(["合計", "", "", f"¥{total:,}"])
    
    charge_table = Table(charge_data, colWidths=[60*mm, 25*mm, 30*mm, 35*mm])
    charge_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), _FONT_NAME),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0.85, 0.9, 1.0)),
        ('BACKGROUND', (0, -1), (-1, -1), colors.Color(0.95, 0.95, 0.95)),
        ('FONTSIZE', (0, -1), (-1, -1), 11),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
    ]))
    elements.append(charge_table)
    
    # Footer
    elements.append(Spacer(1, 5*mm))
    elements.append(Paragraph(
        f"滋賀医科大学学内保育所 あゆっこ  |  {year}年{month}月分",
        ParagraphStyle('Footer', fontName=_FONT_NAME, fontSize=7, textColor=colors.grey, alignment=1)
    ))
    
    doc.build(elements)


def _status_label(status: str) -> str:
    labels = {
        "present": "出席",
        "absent": "欠席",
        "early_leave": "早退",
        "late_arrive": "遅刻",
        "absent_no_plan": "",
    }
    return labels.get(status, "")
