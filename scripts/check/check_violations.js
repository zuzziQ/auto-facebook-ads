const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const inputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_1776401123026.xlsx';
const outputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_violation_check.xlsx';

const violationKeywords = [
    { rule: /cam kết 100%?/gi, label: 'Cam kết 100%' },
    { rule: /khỏi hoàn toàn/gi, label: 'Khỏi hoàn toàn' },
    { rule: /trị dứt điểm/gi, label: 'Trị dứt điểm' },
    { rule: /vĩnh viễn/gi, label: 'Vĩnh viễn' },
    { rule: /không (bao giờ )?tái phát/gi, label: 'Không tái phát' },
    { rule: /bảo hành trọn đời/gi, label: 'Bảo hành trọn đời' },
    { rule: /chữa dứt điểm/gi, label: 'Chữa dứt điểm' }
];

async function checkViolations() {
    if (!fs.existsSync(inputFile)) {
        console.log('File not found: ' + inputFile);
        return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputFile);
    
    // Assume data is in the first sheet
    const worksheet = workbook.worksheets[0];

    // Find the Message column and add the Violation column
    const headerRow = worksheet.getRow(1);
    let msgColIndex = -1;
    
    headerRow.eachCell((cell, colNumber) => {
        if (cell.value && cell.value.toString().includes('Nội Dung')) {
            msgColIndex = colNumber;
        }
    });

    if (msgColIndex === -1) {
        console.log('Could not find column Nội Dung');
        // fallback to col 5 because the columns were: Tên Trang, Post ID, Link Bài, Ngày Đăng, Nội Dung
        msgColIndex = 5; 
    }

    // Add new header
    const violationColIndex = headerRow.actualCellCount + 1;
    headerRow.getCell(violationColIndex).value = 'Lỗi Vi Phạm Y Khoa';
    headerRow.getCell(violationColIndex).font = { bold: true, color: { argb: 'FFFF0000' } };
    headerRow.commit();

    let violationCount = 0;

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header

        const messageCell = row.getCell(msgColIndex);
        const text = messageCell.text || '';
        if (!text) return;

        const foundViolations = [];
        for (const kw of violationKeywords) {
            if (kw.rule.test(text)) {
                foundViolations.push(kw.label);
                // reset lastIndex because we use 'g' flag
                kw.rule.lastIndex = 0; 
            }
        }

        if (foundViolations.length > 0) {
            const violationText = foundViolations.join(', ');
            row.getCell(violationColIndex).value = violationText;
            
            // Highlight the cell
            row.getCell(violationColIndex).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFE0E0' }
            };
            row.getCell(violationColIndex).font = { color: { argb: 'FFFF0000' } };
            violationCount++;
        }
    });

    await workbook.xlsx.writeFile(outputFile);
    console.log('Processed successfully. Found ' + violationCount + ' violations. File saved as ' + outputFile);
}

checkViolations().catch(console.error);
