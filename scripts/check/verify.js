const ExcelJS = require('exceljs');

const outputFile = 'C:\\Users\\Mr. Minh\\Downloads\\page_posts_violation_check_v2.xlsx';

async function verify() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputFile);
    const worksheet = workbook.worksheets[0];
    
    let count = 0;
    let foundCol = -1;
    worksheet.getRow(1).eachCell((cell, colNum) => {
        if (cell.value && cell.value.toString().includes('Lỗi Vi Phạm Y Khoa')) {
            foundCol = colNum;
        }
    });

    console.log('Violation Col Index:', foundCol);
    if (foundCol === -1) return;

    const issues = {};
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const val = row.getCell(foundCol).value;
        if (val) {
            count++;
            const labels = val.toString().split(', ');
            labels.forEach(l => {
                issues[l] = (issues[l]||0) + 1;
            });
        }
    });

    console.log('Actual rows modified:', count);
    console.log('Breakdown:', issues);
}
verify().catch(console.error);
