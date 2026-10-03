const ExcelJS = require('exceljs');

const inputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_1776401123026.xlsx';
const outputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_violation_check_final.xlsx';

const looseRules = [
    // --- Medical / Guarantee ---
    { regex: /cam k[eể]t.*100/i, label: '[Y Tế] Cam kết 100%' },
    { regex: /khỏi.*?hoàn toàn/i, label: '[Y Tế] Khỏi hoàn toàn' },
    { regex: /dứt.*điểm/i, label: '[Y Tế] Trị dứt điểm' },
    { regex: /vĩnh viễn/i, label: '[Y Tế] Vĩnh viễn' },
    { regex: /không.*?tái phát/i, label: '[Y Tế] Không tái phát' },
    { regex: /không.*?bị lại/i, label: '[Y Tế] Không tái phát (bị lại)' },
    { regex: /bảo hành.*?trọn đời/i, label: '[Y Tế] Bảo hành trọn đời' },
    { regex: /hết sạch/i, label: '[Y Tế] Hết sạch' },
    { regex: /sạch.*?100/i, label: '[Y Tế] Sạch 100%' },

    // --- Absolute words (Advertising Law) ---
    { regex: /(^|\\s|[^\\p{L}\\p{N}])(duy nhất|tốt nhất|rẻ nhất|đẹp nhất|đỉnh nhất|xuất sắc nhất|số 1|top 1|hoàn hảo|vô địch|độc nhất)($|\\s|[^\\p{L}\\p{N}])/iu, label: '[Tuyệt Đối]' }
];

async function checkViolations() {
    console.log('Loading workbook...');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputFile);
    const worksheet = workbook.worksheets[0];

    // Find columns
    let msgColIndex = 5; 
    let violationColIndex = worksheet.getRow(1).actualCellCount + 1;

    worksheet.getRow(1).eachCell((cell, colNumber) => {
        const val = cell.value ? cell.value.toString() : '';
        if (val.includes('Nội Dung')) msgColIndex = colNumber;
        if (val.includes('Lỗi Vi Phạm')) violationColIndex = colNumber;
    });

    // Write Header
    worksheet.getRow(1).getCell(violationColIndex).value = 'Tổng Hợp Lỗi Vi Phạm (Y Tế & Luật QC)';
    worksheet.getRow(1).getCell(violationColIndex).font = { bold: true, color: { argb: 'FFFF0000' } };
    worksheet.getRow(1).commit();

    let count = 0;
    const issues = {};

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        let cellVal = row.getCell(msgColIndex).value;
        let text = '';
        if (cellVal !== null && cellVal !== undefined) {
             if (cellVal.richText) text = cellVal.richText.map(rt => rt.text).join('');
             else text = cellVal.toString();
        }
        if (!text) return;

        text = text.normalize('NFC');
        const found = [];

        for (const kw of looseRules) {
            const match = text.match(kw.regex);
            if (match) {
                if (kw.label === '[Tuyệt Đối]') {
                     // Get exact matched word nicely formatted
                     let word = match[2];
                     found.push('[Tuyệt Đối] ' + word);
                } else {
                     found.push(kw.label);
                }
            }
        }

        if (found.length > 0) {
            const unique = [...new Set(found)];
            row.getCell(violationColIndex).value = unique.join(', ');
            row.getCell(violationColIndex).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0E0' } };
            row.getCell(violationColIndex).font = { color: { argb: 'FFFF0000' } };
            count++;
            
            unique.forEach(l => issues[l] = (issues[l]||0)+1);
        } else {
            row.getCell(violationColIndex).value = '';
            row.getCell(violationColIndex).fill = { type: 'pattern', pattern: 'none' };
        }
    });

    console.log('Writing file...');
    await workbook.xlsx.writeFile(outputFile);
    console.log('Processed successfully. Found ' + count + ' violations total.');
    console.log(issues);
}

checkViolations().catch(console.error);
