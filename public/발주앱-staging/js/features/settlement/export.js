// ============================================================
// features/settlement/export.js — 정산 데이터 엑셀 내보내기 (SheetJS)
// 의존: 전역 XLSX (SheetJS CDN)
// ============================================================

/**
 * 정산 데이터를 엑셀로 내보내고 다운로드 트리거
 *
 * @param {Order[]} orders - 정산 대상 발주서 목록 (출고완료만 필터됨)
 * @param {PeriodMode} mode - 기간 단위
 * @param {string | {year:number, quarter:number} | DateRange} value - 모드별 선택값
 * @returns {void} 다운로드 트리거 후 즉시 반환
 *
 * @example
 * exportSettlementExcel(orders, 'monthly', '2026-06');
 * // → settlement_monthly_202606.xlsx 다운로드
 */
function exportSettlementExcel(orders, mode, value) {
  const completed = orders.filter(o => o.status === '출고완료');

  const rows = completed.map(o => ({
    '발주번호': o.orderNum,
    '납품처': o.deliveryTo,
    '시공 주소': o.address || '',
    '창고': o.warehouse || '',
    '발주일': o.orderDate || '',
    '출고완료일': o.shipDate || '',
    '공급가액': o.totalSupply || 0,
    '부가세': o.totalVat || 0,
    '합계': o.totalAmount || 0
  }));

  // 합계 행 추가
  const totalSupply = completed.reduce((s, o) => s + (o.totalSupply || 0), 0);
  const totalVat = completed.reduce((s, o) => s + (o.totalVat || 0), 0);
  const totalAmount = completed.reduce((s, o) => s + (o.totalAmount || 0), 0);
  rows.push({
    '발주번호': `합계 (${completed.length}건)`,
    '납품처': '',
    '시공 주소': '',
    '창고': '',
    '발주일': '',
    '출고완료일': '',
    '공급가액': totalSupply,
    '부가세': totalVat,
    '합계': totalAmount
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  // 컬럼 너비 설정
  ws['!cols'] = [
    { wch: 16 }, { wch: 12 }, { wch: 32 }, { wch: 8 },
    { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '정산');

  const valueStr = typeof value === 'object'
    ? (value.year ? `${value.year}Q${value.quarter}` : `${value.startDate}_${value.endDate}`)
    : String(value).replace(/-/g, '');
  const fileName = `settlement_${mode}_${valueStr}.xlsx`;
  XLSX.writeFile(wb, fileName);
}
