// seed-ledger-print-test.js — 로컬 에뮬레이터 원장/인쇄 확인용 고정 데이터
// 운영 금지 + [2026-09-03 Codex P2 fix] hanger-emu (18080/19099) 외 다른 emu 경로 차단
//   기존: || 폴백만 있어서 tooktak emu(8080/9099) env 세팅 상태로 실행 시 그쪽에 씀 → 데이터 오염
//   fix: hanger-emu 포트 강제 검증. 다른 값 있으면 즉시 throw

const EXPECTED_FS = 'localhost:18080';
const EXPECTED_AUTH = 'localhost:19099';
const currentFs = process.env.FIRESTORE_EMULATOR_HOST;
const currentAuth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (currentFs && currentFs !== EXPECTED_FS) {
  throw new Error(`[seed guard] FIRESTORE_EMULATOR_HOST='${currentFs}' 은 hanger-emu(${EXPECTED_FS}) 아님. 다른 emu 데이터 오염 방지 차단. env 지우거나 hanger-emu 로 설정 후 재실행.`);
}
if (currentAuth && currentAuth !== EXPECTED_AUTH) {
  throw new Error(`[seed guard] FIREBASE_AUTH_EMULATOR_HOST='${currentAuth}' 은 hanger-emu(${EXPECTED_AUTH}) 아님. 다른 emu 데이터 오염 방지 차단.`);
}
process.env.FIRESTORE_EMULATOR_HOST = EXPECTED_FS;
process.env.FIREBASE_AUTH_EMULATOR_HOST = EXPECTED_AUTH;

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'tooktakproject' });
const db = admin.firestore();
const auth = admin.auth();

const TEST_ACCOUNTS = [
  {
    uid: 'ledger-print-orderer-1',
    id: 'ledger1',
    email: 'ledger1@local.test',
    password: '123456',
    name: '원장테스트상사',
    role: 'orderer',
    deliveryName: '원장테스트상사',
    empCd: '',
    bizCd: '',
  },
  {
    uid: 'ledger-print-orderer-2',
    id: 'ledger2',
    email: 'ledger2@local.test',
    password: '123456',
    name: '남다른디자인',
    role: 'orderer',
    deliveryName: '남다른디자인',
    empCd: '',
    bizCd: '',
  },
];

const TEST_ORDER_NUMS = [
  '20260701-901',
  '20260702-902',
  '20260708-903',
  '20260712-904',
  '20260718-905',
  '20260725-906',
  '20260728-907',
  '20260730-908',
];

const TEST_PAYMENT_IDS = [
  'ledger_print_test_pay_1',
  'ledger_print_test_pay_2',
  'ledger_print_test_pay_3',
  'ledger_print_test_pay_4',
];

function makeOrder({ id, orderNum, deliveryTo, address, orderDate, shipDate, warehouse, amount, note }) {
  const supply = Math.round(amount / 1.1);
  const vat = amount - supply;
  return {
    id,
    orderNum,
    deliveryTo,
    address,
    orderDate,
    shipDate,
    warehouse,
    // [2026-08-31] legacy '출고완료' → 실무 '발주확정'으로 이관 (메모리 규칙 준수)
    status: '발주확정',
    note,
    upperMaterials: [
      { name: '포스트바 2400', color: '화이트', qty: 8, unitPrice: 12000 },
      { name: '옷봉 2400', color: '화이트', qty: 4, unitPrice: 5000 },
    ],
    shelfItems: [
      { name: '선반 770', entries: [{ color: '솔리드', size: '770', qty: 6, unitPrice: 5300 }] },
    ],
    drawerItems: [
      {
        id: id * 100,
        itemId: 1,
        displayName: '겉서랍 2단',
        itemName: '겉서랍 2단',
        color: '솔리드',
        requiredQty: 1,
        unitPrice: 69000,
        warehouse,
        orderId: id,
        createdAt: `${orderDate}T09:00:00.000Z`,
      },
    ],
    sharedColor: '솔리드',
    totalSupply: supply,
    totalVat: vat,
    totalAmount: amount,
    createdBy: 'admin',
    createdAt: `${orderDate}T09:00:00.000Z`,
    updatedAt: `${shipDate}T09:00:00.000Z`,
    statusHistory: [
      { status: '발주대기', changedAt: `${orderDate}T09:00:00.000Z`, note: '원장 인쇄 테스트' },
      { status: '발주확정', changedAt: `${shipDate}T09:00:00.000Z`, note: '' },
    ],
  };
}

function makeInvoice(order, index) {
  return {
    id: `ledger_print_test_inv_${order.orderNum}`,
    orderNum: order.orderNum,
    shipDate: order.shipDate,
    deliveryTo: order.deliveryTo,
    address: order.address,
    items: [
      { name: '포스트바 2400', spec: '화이트', qty: 8, unitPrice: 12000, supply: 96000, vat: 9600, priceUnknown: false },
      { name: '옷봉 2400', spec: '화이트', qty: 4, unitPrice: 5000, supply: 20000, vat: 2000, priceUnknown: false },
      { name: '선반 770', spec: '솔리드 770', qty: 6, unitPrice: 5300, supply: 31800, vat: 3180, priceUnknown: false },
      { name: '겉서랍 2단', spec: '솔리드', qty: 1, unitPrice: 69000, supply: 69000, vat: 6900, priceUnknown: false },
    ],
    totalSupply: order.totalSupply,
    totalVat: order.totalVat,
    totalAmount: order.totalAmount,
    createdAt: `${order.shipDate}T10:00:00.000Z`,
    createdBy: 'admin',
    issuerName: '관리자',
    serial: `${order.shipDate.replace(/-/g, '/')} -${index + 1}`,
    sentToCustomer: true,
    sentAt: `${order.shipDate}T10:05:00.000Z`,
    cancelled: false,
  };
}

async function main() {
  for (const acc of TEST_ACCOUNTS) {
    try {
      await auth.createUser({
        uid: acc.uid,
        email: acc.email,
        password: acc.password,
        displayName: acc.name,
      });
    } catch (e) {
      if (e.code === 'auth/uid-already-exists' || e.code === 'auth/email-already-exists') {
        try {
          const user = await auth.getUserByEmail(acc.email);
          await auth.updateUser(user.uid, { password: acc.password, displayName: acc.name });
        } catch (_) {}
      } else {
        throw e;
      }
    }
  }

  const orders = [
    makeOrder({ id: 9901, orderNum: '20260701-901', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 101', orderDate: '2026-07-01', shipDate: '2026-07-03', warehouse: '시흥', amount: 354090, note: '원장 인쇄 테스트 1' }),
    makeOrder({ id: 9902, orderNum: '20260702-902', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 102', orderDate: '2026-07-02', shipDate: '2026-07-10', warehouse: '시흥', amount: 349800, note: '원장 인쇄 테스트 2' }),
    makeOrder({ id: 9903, orderNum: '20260708-903', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 103', orderDate: '2026-07-08', shipDate: '2026-07-11', warehouse: '평택', amount: 512600, note: '원장 인쇄 테스트 3' }),
    makeOrder({ id: 9904, orderNum: '20260712-904', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 104', orderDate: '2026-07-12', shipDate: '2026-07-14', warehouse: '시흥', amount: 198000, note: '원장 인쇄 테스트 4' }),
    makeOrder({ id: 9905, orderNum: '20260718-905', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 105', orderDate: '2026-07-18', shipDate: '2026-07-20', warehouse: '평택', amount: 736450, note: '원장 인쇄 테스트 5' }),
    makeOrder({ id: 9906, orderNum: '20260725-906', deliveryTo: '원장테스트상사', address: '서울 강남구 테스트로 106', orderDate: '2026-07-25', shipDate: '2026-07-26', warehouse: '시흥', amount: 286000, note: '원장 인쇄 테스트 6' }),
    makeOrder({ id: 9907, orderNum: '20260728-907', deliveryTo: '남다른디자인', address: '경기 성남시 샘플동 201', orderDate: '2026-07-28', shipDate: '2026-07-29', warehouse: '시흥', amount: 429000, note: '원장 인쇄 테스트 타거래처 1' }),
    makeOrder({ id: 9908, orderNum: '20260730-908', deliveryTo: '남다른디자인', address: '경기 성남시 샘플동 202', orderDate: '2026-07-30', shipDate: '2026-07-31', warehouse: '평택', amount: 220000, note: '원장 인쇄 테스트 타거래처 2' }),
  ];
  const invoices = orders.map(makeInvoice);
  const payments = [
    { id: TEST_PAYMENT_IDS[0], customer: '원장테스트상사', date: '2026-07-05', amount: 300000, memo: '7월 1차 입금', createdAt: '2026-07-05T09:00:00.000Z', createdBy: 'admin' },
    { id: TEST_PAYMENT_IDS[1], customer: '원장테스트상사', date: '2026-07-15', amount: 500000, memo: '7월 2차 입금', createdAt: '2026-07-15T09:00:00.000Z', createdBy: 'admin' },
    { id: TEST_PAYMENT_IDS[2], customer: '원장테스트상사', date: '2026-07-27', amount: 250000, memo: '월말 일부 입금', createdAt: '2026-07-27T09:00:00.000Z', createdBy: 'admin' },
    { id: TEST_PAYMENT_IDS[3], customer: '남다른디자인', date: '2026-07-31', amount: 200000, memo: '샘플 입금', createdAt: '2026-07-31T09:00:00.000Z', createdBy: 'admin' },
  ];

  await db.runTransaction(async tx => {
    const accountsRef = db.collection('hanger_data').doc('accounts');
    const ordersRef = db.collection('hanger_data').doc('orders');
    const invoicesRef = db.collection('hanger_data').doc('invoices');
    const accountsSnap = await tx.get(accountsRef);
    const ordersSnap = await tx.get(ordersRef);
    const invoicesSnap = await tx.get(invoicesRef);
    const oldAccounts = accountsSnap.exists ? (accountsSnap.data().value || []) : [];
    const oldOrders = ordersSnap.exists ? (ordersSnap.data().value || []) : [];
    const oldInvoices = invoicesSnap.exists ? (invoicesSnap.data().value || []) : [];

    tx.set(accountsRef, {
      value: [
        ...oldAccounts.filter(a => !TEST_ACCOUNTS.some(t => t.id === (a && a.id) || t.email === (a && a.email))),
        ...TEST_ACCOUNTS.map(({ password, uid, ...acc }) => acc),
      ],
      updatedAt: new Date().toISOString(),
    });
    tx.set(ordersRef, {
      value: [...oldOrders.filter(o => !TEST_ORDER_NUMS.includes(o && o.orderNum)), ...orders],
      updatedAt: new Date().toISOString(),
    });
    tx.set(invoicesRef, {
      value: [...oldInvoices.filter(i => !TEST_ORDER_NUMS.includes(i && i.orderNum)), ...invoices],
      updatedAt: new Date().toISOString(),
    });
  });

  const batch = db.batch();
  orders.forEach(order => batch.set(db.collection('hanger_orders').doc(order.orderNum), order));
  payments.forEach(payment => batch.set(db.collection('hanger_payments').doc(payment.id), payment));
  await batch.commit();

  console.log('✓ 로컬 원장 인쇄 테스트 데이터 생성 완료');
  console.log('  거래처: 원장테스트상사 6건 + 입금 3건');
  console.log('  거래처: 남다른디자인 2건 + 입금 1건');
  console.log('  발주자 계정: ledger1 / 123456 (원장테스트상사)');
  console.log('  발주자 계정: ledger2 / 123456 (남다른디자인)');
  console.log('  로그인: admin / 123456');
  console.log('  확인: 정산 > 거래처 원장 > 원장테스트상사 > 인쇄');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('실패:', e);
  process.exit(1);
});
