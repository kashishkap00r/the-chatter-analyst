import { describe, expect, it } from 'vitest';
import { parseThreadEdition } from './ingest';

// Fixtures mirror the plain-text shape convertHtmlToPlainText produces for real
// editions: an <h1> category line, an <h2> "a | b | c" header, a description,
// a "[ Concall ]" / "[ Speech ]" marker, then summary → quote → speaker triples.

const parse = (text: string) => parseThreadEdition(text, { sourceKind: 'pdf_text' });

const companyNamed = (text: string, name: string) =>
  parse(text).companies.find((company) => company.companyName === name);

describe('parseThreadEdition', () => {
  it('parses the classic three-field company header', () => {
    const text = [
      'Metals',
      'Tata Steel | Large Cap | Metals',
      'Tata Steel is an integrated steel producer.',
      '[ Concall ]',
      'Margins improved on lower coking coal costs.',
      '"Our EBITDA per tonne rose meaningfully this quarter."',
      '— T V Narendran, CEO & MD',
    ].join('\n');

    const company = companyNamed(text, 'Tata Steel');
    expect(company?.marketCapCategory).toBe('Large Cap');
    expect(company?.industry).toBe('Metals');
    expect(company?.quotes).toHaveLength(1);
    expect(company?.quotes[0].speakerName).toBe('T V Narendran');
  });

  it('parses two-field company headers, taking industry from the category heading', () => {
    const text = [
      'Automobiles',
      'Bajaj Auto | Large Cap',
      'Bajaj Auto is a leading global manufacturer of two-wheelers.',
      '[ Concall ]',
      'Exports are recovering.',
      '"Exports grew strongly across Africa and Latin America."',
      '— Rakesh Sharma, Managing Director',
      'Domestic share held steady.',
      '"We held our share in the 125cc-plus segment."',
      '— Rakesh Sharma, Managing Director',
      'Financial Services',
      'State Bank of India | Large Cap',
      'SBI is the largest public sector bank.',
      '[ Concall ]',
      'Credit growth stays healthy.',
      '"We expect loan growth of 12 to 14% this year."',
      '— C S Setty, Chairman',
    ].join('\n');

    const bajaj = companyNamed(text, 'Bajaj Auto');
    expect(bajaj?.marketCapCategory).toBe('Large Cap');
    expect(bajaj?.industry).toBe('Automobiles');
    expect(bajaj?.quotes).toHaveLength(2);

    const sbi = companyNamed(text, 'State Bank of India');
    expect(sbi?.industry).toBe('Financial Services');
  });

  it('parses a regulator speech with a three-field header and dash-less speaker lines', () => {
    const text = [
      'Regulators',
      'Reserve Bank of India | Dr. Poonam Gupta Address | Macro Economy & Financial Stability',
      'At a banking conclave, the Deputy Governor outlined macro resilience.',
      '[ Speech ]',
      'Equities have lagged the real economy.',
      '"The equity markets, on the other hand, have not tracked the same optimism."',
      'Dr. Poonam Gupta, Deputy Governor, Reserve Bank of India',
      'The rupee move looks like an overcorrection.',
      '"One may think of the cumulative depreciation as an overcorrection."',
      'Dr. Poonam Gupta, Deputy Governor, Reserve Bank of India',
    ].join('\n');

    const rbi = companyNamed(text, 'Reserve Bank of India');
    expect(rbi?.marketCapCategory).toBe('Regulator');
    expect(rbi?.industry).toBe('Macro Economy & Financial Stability');
    expect(rbi?.companyDescription).toBe('At a banking conclave, the Deputy Governor outlined macro resilience.');
    expect(rbi?.quotes).toHaveLength(2);
    expect(rbi?.quotes[0].quote).toBe('The equity markets, on the other hand, have not tracked the same optimism.');
    expect(rbi?.quotes[0].summary).toBe('Equities have lagged the real economy.');
    expect(rbi?.quotes[0].speakerName).toBe('Dr. Poonam Gupta');
    expect(rbi?.quotes[0].speakerDesignation).toBe('Deputy Governor, Reserve Bank of India');
  });

  it('parses a two-field regulator interview header and keeps the edition from coming back empty', () => {
    const text = [
      'Regulator',
      'Insurance Regulatory and Development Authority of India | Insurance Decommissioned',
      'IRDAI is the statutory body regulating insurance in India.',
      '[ Interview ]',
      'Costs have ballooned across the industry.',
      '"In FY21, the industry\'s cost of doing business was around 16.5%. Today, it is 22%."',
      '— Ajay Seth, Chairman, IRDAI',
      'Automobiles',
      'Bajaj Auto | Large Cap',
      'Bajaj Auto makes two-wheelers.',
      '[ Concall ]',
      'Exports are recovering.',
      '"Exports grew strongly."',
      '— Rakesh Sharma, Managing Director',
    ].join('\n');

    const irdai = companyNamed(text, 'Insurance Regulatory and Development Authority of India');
    expect(irdai?.marketCapCategory).toBe('Regulator');
    expect(irdai?.industry).toBe('Insurance Decommissioned');
    expect(irdai?.quotes).toHaveLength(1);
    expect(irdai?.quotes[0].speakerName).toBe('Ajay Seth');
    expect(irdai?.quotes[0].speakerDesignation).toBe('Chairman, IRDAI');

    expect(parse(text).companies.map((company) => company.companyName)).toEqual([
      'Insurance Regulatory and Development Authority of India',
      'Bajaj Auto',
    ]);
  });

  it('carries the category heading to a second regulator that has no heading of its own', () => {
    const text = [
      'Regulators',
      'Reserve Bank of India | Dr. Poonam Gupta Address | Macro Economy',
      'The Deputy Governor spoke on macro resilience.',
      '[ Speech ]',
      'Growth floor is rising.',
      '"India is advancing on a resilient growth path."',
      'Dr. Poonam Gupta, Deputy Governor, Reserve Bank of India',
      'SEBI Chairman Address | Indian Capital Markets & Regulatory Reforms',
      'The SEBI Chairman outlined bond market reforms.',
      '[ Speech ]',
      'IPO momentum continues.',
      '"Around 55% of IPO proceeds have represented fresh capital."',
      'Shri Tuhin Kanta Pandey, Chairman, SEBI',
    ].join('\n');

    const sebi = companyNamed(text, 'SEBI Chairman Address');
    expect(sebi?.marketCapCategory).toBe('Regulator');
    expect(sebi?.industry).toBe('Indian Capital Markets & Regulatory Reforms');
    expect(sebi?.quotes).toHaveLength(1);
    expect(sebi?.quotes[0].speakerName).toBe('Shri Tuhin Kanta Pandey');
  });

  it('flips a "speech title | institution" header and defaults a heading-less speech to Regulator', () => {
    const text = [
      'Rohit Jain on Building Deep and Resilient Financial Markets for a Viksit Bharat | Reserve Bank of India',
      'The Reserve Bank of India is the central bank.',
      '[Reference]',
      'Bond markets need depth.',
      '"Deep markets are the backbone of a developed economy."',
      '- Rohit Jain, Deputy Governor, RBI',
    ].join('\n');

    const rbi = companyNamed(text, 'Reserve Bank of India');
    expect(rbi?.marketCapCategory).toBe('Regulator');
    expect(rbi?.industry).toBe('Rohit Jain on Building Deep and Resilient Financial Markets for a Viksit Bharat');
    expect(rbi?.quotes).toHaveLength(1);
  });

  it('does not end a multi-paragraph quote on a short line that is still inside the quotation', () => {
    const text = [
      'Regulator',
      'Reserve Bank of India | Governor Address | Banking',
      'The Governor spoke on AI in banking.',
      '[ Speech ]',
      'Banks must adapt.',
      '"First, data matters,',
      'second, governance, and third, people."',
      'Sanjay Malhotra, Governor, Reserve Bank of India',
    ].join('\n');

    const rbi = companyNamed(text, 'Reserve Bank of India');
    expect(rbi?.quotes).toHaveLength(1);
    expect(rbi?.quotes[0].quote).toBe('First, data matters, second, governance, and third, people.');
    expect(rbi?.quotes[0].speakerName).toBe('Sanjay Malhotra');
  });
});
