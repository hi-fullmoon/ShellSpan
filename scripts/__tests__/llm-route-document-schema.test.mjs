import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const schema=JSON.parse(readFileSync('protocol/llm/routes.schema.json','utf8'));
const validator=new Ajv2020({strict:true,allErrors:true});
const validate=validator.compile(schema);
describe('persisted native route document schema',()=>{
  it('accepts the native initial snapshot with a null default selection',()=>{
    expect(validate({schemaVersion:1,revision:1,routes:[],defaultSelection:null}),validator.errorsText(validate.errors)).toBe(true);
  });
  it('preserves optional native catalog nulls while rejecting two concrete catalogs',()=>{
    const rule=schema.properties.routes.items;
    const catalog=validator.compile({type:'object',properties:{ models:rule.properties.models, modelOverrides:rule.properties.modelOverrides },allOf:[rule.allOf[0]],additionalProperties:false});
    expect(catalog({models:null,modelOverrides:null})).toBe(true);
    expect(catalog({models:null,modelOverrides:null,apiKey:'unexpected'})).toBe(false);
    const presets=JSON.parse(readFileSync('protocol/llm/catalog.json','utf8')).presets;
    const preset=presets.anthropic;
    const [id, definition]=Object.entries(preset.models)[0];
    const concrete={ [id]:{ ...definition, requestOutputTokens: Math.min(definition.maxOutputTokens, 16_384), compat:{...preset.compat,...definition.compat} } };
    expect(catalog({models:concrete,modelOverrides:null}),validator.errorsText(catalog.errors)).toBe(true);
    expect(catalog({models:null,modelOverrides:concrete}),validator.errorsText(catalog.errors)).toBe(true);
    expect(catalog({models:concrete,modelOverrides:concrete})).toBe(false);
    expect(catalog.errors.some(error=>error.keyword==='not')).toBe(true);
    expect(validate({schemaVersion:1,revision:1,routes:[],inlineCredential:'unexpected'})).toBe(false);
  });
});
