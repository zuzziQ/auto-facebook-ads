const ExcelJS = require('exceljs');

const inputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_1776401123026.xlsx';
const outputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_violation_check_loose.xlsx';

const looseRules = [
    { regex: /cam k[eể]t.*100/i, label: 'Cam kết 100%' },
    { regex: /khỏi.*?hoàn toàn/i, label: 'Khỏi hoàn toàn' },
    { regex: /dứt.*điểm/i, label: 'Trị dứt điểm' },
    { regex: /vĩnh viễn/i, label: 'Vĩnh viễn' },
    { regex: /không.*?tái phát/i, label: 'Không tái phát' },
    { regex: /không.*?bị lại/i, label: 'Không tái phát (bị lại)' },
    { regex: /bảo hành.*?trọn đời/i, label: 'Bảo hành trọn đời' },
    { regex: /hết sạch/i, label: 'Hết sạch (Cam kết tuyệt đối)' },
    { regex: /sạch.*?100/i, label: 'Sạch 100%' }
];

async function checkViolations() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputFile);
    const worksheet = workbook.worksheets[0];

    let msgColIndex = 5; 
    let violationColIndex = worksheet.getRow(1).actualCellCount + 1;

    worksheet.getRow(1).eachCell((cell, colNumber) => {
        const val = cell.value ? cell.value.toString() : '';
        if (val.includes('Nội Dung')) msgColIndex = colNumber;
        if (val.includes('Lỗi Vi Phạm Y Khoa')) violationColIndex = colNumber;
    });

    worksheet.getRow(1).getCell(violationColIndex).value = 'Lỗi Vi Phạm Y Khoa (Mới Nâng Cấp)';
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
            if (kw.regex.test(text)) {
                found.push(kw.label);
                kw.regex.lastIndex = 0;
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

    await workbook.xlsx.writeFile(outputFile);
    console.log('Loose Match Processed successfully. Found ' + count + ' violations.');
    console.log(issues);
}

checkViolations().catch(console.error);
