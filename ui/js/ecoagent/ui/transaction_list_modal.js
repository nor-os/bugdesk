/**
 * transaction_list_modal.js — list of transactions making up one
 * Transaction-Flow-Matrix cell. Opened on click of a non-zero cell.
 *
 * Built on `openModal` so chrome / Esc / focus trap match every other
 * modal in the app.
 */

import { openModal } from './modal.js';


export function openTransactionListModal({ title, subtitle, transactions = [] }) {
    const content = document.createElement('div');
    content.className = 'ea-txn-modal__body';
    if (subtitle) {
        const sub = document.createElement('div');
        sub.className = 'ea-modal__hint';
        sub.textContent = subtitle;
        content.appendChild(sub);
    }
    if (transactions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ea-table__empty';
        empty.textContent = 'No transactions in this cell.';
        content.appendChild(empty);
    } else {
        const tbl = document.createElement('table');
        tbl.className = 'ea-table ea-txn-table';
        tbl.innerHTML = `
            <thead><tr>
                <th class="ea-table__cell">Tick</th>
                <th>Debit (from)</th>
                <th>Credit (to)</th>
                <th class="ea-table__cell">Amount</th>
                <th>Source</th>
            </tr></thead>
            <tbody>
                ${transactions.map((t) => `
                    <tr>
                        <td class="ea-table__cell">${t.tick}</td>
                        <td>
                            <span class="ea-txn-table__agent">${esc(t.debit_agent || '')}</span>
                            <span class="ea-txn-table__sub">${esc(t.debit_label || '')}</span>
                        </td>
                        <td>
                            <span class="ea-txn-table__agent">${esc(t.credit_agent || '')}</span>
                            <span class="ea-txn-table__sub">${esc(t.credit_label || '')}</span>
                        </td>
                        <td class="ea-table__cell">${Number(t.amount).toFixed(2)}</td>
                        <td class="ea-txn-table__source">
                            ${esc(t.market ? `market:${t.market}` : (t.note || 'flow'))}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
            <tfoot>
                <tr>
                    <th class="ea-table__cell">Σ</th>
                    <th colspan="2"></th>
                    <th class="ea-table__cell">
                        ${transactions.reduce((s, t) => s + Number(t.amount), 0).toFixed(2)}
                    </th>
                    <th>${transactions.length} txn${transactions.length === 1 ? '' : 's'}</th>
                </tr>
            </tfoot>
        `;
        content.appendChild(tbl);
    }

    return openModal({
        title:   String(title || 'Transactions'),
        icon:    'receipt_long',
        content,
        width:   860,
        height:  520,
        actions: [{ label: 'Close', value: null, primary: true }],
    });
}


function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
