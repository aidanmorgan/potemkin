import { parseJunitXml } from '../../../src/conformance/junit';

describe('Specmatic JUnit parser', () => {
  it('parses totals and exact failure identity from the diagnostic fields', () => {
    const report = parseJunitXml(`
      <testsuite tests="3" failures="1" errors="0" skipped="1">
        <testcase classname="crm" name="create lead" />
        <testcase classname="crm" name="read unknown lead">
          <failure message="status mismatch">method=GET path=/leads/{id} scenario="read unknown lead" expected=200 actual=404 rule-id=lead-read</failure>
        </testcase>
        <testcase classname="crm" name="skipped"><skipped /></testcase>
      </testsuite>`);

    expect(report.tests).toBe(3);
    expect(report.failures).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.cases).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/leads/{id}',
        scenario: 'read unknown lead',
        expectedStatus: '200',
        actualStatus: '404',
        ruleId: 'lead-read',
      }),
    ]);
  });

  it('accepts self-closing failure elements and XML-escaped messages', () => {
    const report = parseJunitXml(
      '<testsuite tests="1" failures="1"><testcase name="bad"><failure message="a &lt; b" /></testcase></testsuite>',
    );
    expect(report.cases[0]).toEqual(expect.objectContaining({ message: 'a < b', testName: 'bad' }));
  });

  it('uses aggregate totals when a JUnit file contains multiple suites', () => {
    const report = parseJunitXml(`
      <testsuites tests="3" failures="1" errors="0" skipped="1">
        <testsuite tests="2" failures="1" errors="0" skipped="0">
          <testcase name="bad"><failure message="broken" /></testcase>
          <testcase name="good" />
        </testsuite>
        <testsuite tests="1" failures="0" errors="0" skipped="1">
          <testcase name="skipped"><skipped /></testcase>
        </testsuite>
      </testsuites>`);
    expect(report).toMatchObject({ tests: 3, failures: 1, errors: 0, skipped: 1 });
    expect(report.cases).toHaveLength(1);
    expect(report.testCases).toEqual([
      expect.objectContaining({ testName: 'bad', passed: false, skipped: false }),
      expect.objectContaining({ testName: 'good', passed: true, skipped: false }),
      expect.objectContaining({ testName: 'skipped', passed: false, skipped: true }),
    ]);
  });

  it('retains successful testcase identity with explicit unknown status fields', () => {
    const report = parseJunitXml(
      '<testsuite tests="1" failures="0"><testcase classname="crm" name="create lead" /></testsuite>',
    );

    expect(report.testCases).toEqual([
      expect.objectContaining({
        classname: 'crm',
        testName: 'create lead',
        method: 'UNKNOWN',
        path: 'UNKNOWN',
        scenario: 'create lead',
        expectedStatus: 'UNKNOWN',
        actualStatus: 'UNKNOWN',
        passed: true,
        skipped: false,
        message: '',
      }),
    ]);
  });

  it('extracts method, path, status, and example identity from Specmatic success names', () => {
    const report = parseJunitXml(
      '<testsuite tests="1" failures="0"><testcase classname="specmatic" name="Contract Tests &gt; contractTest() &gt; +ve  Scenario: GET /leads/(id:uuid) -&gt; 200 with the request from the example \'Lead__GET__42\'" /></testsuite>',
    );

    expect(report.testCases).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/leads/{id}',
        scenario: 'Lead__GET__42',
        expectedStatus: '200',
        actualStatus: '200',
        passed: true,
      }),
    ]);
  });

  it('extracts identity from Specmatic prose diagnostics', () => {
    const report = parseJunitXml(`
      <testsuite tests="1" failures="1">
        <testcase name="generated negative">
          <failure message="status mismatch">Testing scenario "Mark lead as contacted. Response: Lead not found"
            API: POST /leads/(id:uuid)/contact -&gt; 4xx
            Specification expected status 404 but response contained status 400</failure>
        </testcase>
      </testsuite>`);
    expect(report.cases[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/leads/{id}/contact',
        scenario: 'Mark lead as contacted. Response: Lead not found',
        expectedStatus: '404',
        actualStatus: '400',
      }),
    );
  });
});
