const fs = require('fs');
const ExcelJS = require('exceljs');

const inputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_1776401123026.xlsx';
const outputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_violation_check_v2.xlsx';

const violationKeywords = [
    { search: 'cam kết 10', label: 'Cam kết 100%' },
    { search: 'khỏi hoàn toàn', label: 'Khỏi hoàn toàn' },
    { search: 'trị dứt điểm', label: 'Trị dứt điểm' },
    { search: 'chữa dứt điểm', label: 'Chữa dứt điểm' },
    { search: 'vĩnh viễn', label: 'Vĩnh viễn' },
    { search: 'không tái phát', label: 'Không tái phát' },
    { search: 'ko tái phát', label: 'Không tái phát' },
    { search: 'không bao giờ tái phát', label: 'Không tái phát' },
    { search: 'bảo hành trọn đời', label: 'Bảo hành trọn đời' },
];

async function checkViolations() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputFile);
    const worksheet = workbook.worksheets[0];

    const headerRow = worksheet.getRow(1);
    let msgColIndex = -1;
    let oldViolationColIndex = -1;
    
    headerRow.eachCell((cell, colNumber) => {
        const hVal = cell.value ? cell.value.toString() : '';
        if (hVal.includes('Nội Dung')) {
            msgColIndex = colNumber;
        }
        if (hVal.includes('Lỗi Vi Phạm Y Khoa')) {
            oldViolationColIndex = colNumber;
        }
    });

    if (msgColIndex === -1) msgColIndex = 5; 

    const violationColIndex = oldViolationColIndex !== -1 ? oldViolationColIndex : headerRow.actualCellCount + 1;
    headerRow.getCell(violationColIndex).value = 'Lỗi Vi Phạm Y Khoa (V2)';
    headerRow.getCell(violationColIndex).font = { bold: true, color: { argb: 'FFFF0000' } };
    headerRow.commit();

    let violationCount = 0;

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; 

        // Extract raw string value (safest way to bypass rich text or truncations)
        let cellVal = row.getCell(msgColIndex).value;
        let text = '';
        if (cellVal !== null && cellVal !== undefined) {
             if (cellVal.richText) {
                 text = cellVal.richText.map(rt => rt.text).join('');
             } else {
                 text = cellVal.toString();
             }
        }
        
        if (!text) return;

        // clean text
        const safeText = text.normalize('NFC').toLowerCase();

        const foundViolations = [];
        for (const kw of violationKeywords) {
            if (safeText.includes(kw.search.normalize('NFC').toLowerCase())) {
                foundViolations.push(kw.label);
            }
        }

        if (foundViolations.length > 0) {
            // deduplicate labels
            const uniqueLabels = [...new Set(foundViolations)];
            const violationText = uniqueLabels.join(', ');
            
            row.getCell(violationColIndex).value = violationText;
            row.getCell(violationColIndex).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFE0E0' }
            };
            row.getCell(violationColIndex).font = { color: { argb: 'FFFF0000' } };
            violationCount++;
        } else {
            // clear if previously marked falsely
             row.getCell(violationColIndex).value = '';
             row.getCell(violationColIndex).fill = { type: 'pattern', pattern: 'none' };
        }
    });

    await workbook.xlsx.writeFile(outputFile);
    console.log('Processed v2 successfully. Found ' + violationCount + ' violations. File saved as ' + outputFile);
}

checkViolations().catch(console.error);
